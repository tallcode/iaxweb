import type { BackfillMode, BackfillRecord, BackfillResult } from '../records/embedding-backfill-store.js'
import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { backup, DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'
import { eligibleForBackfill, EmbeddingBackfillStore } from '../records/embedding-backfill-store.js'
import { SPEAKER_MODEL_SHA256, SPEAKER_VERSION } from './speaker-model.mjs'
import { readSpeakerWav, speakerWavFile } from './speaker-wav.js'
import { SpeakerExtractor } from './speaker.js'

const inventorySchema = z.object({
  records: z.number(),
  recordingSeconds: z.number(),
  filesPresent: z.number(),
  filesMissing: z.number(),
  filesInvalid: z.number(),
  voicedTooShort: z.number(),
  eligible: z.number(),
  eligibleSeconds: z.number(),
  otherVersion: z.number(),
  statusCounts: z.record(z.string(), z.number()),
})
const manifestSchema = z.object({
  format: z.literal(2),
  version: z.literal(SPEAKER_VERSION),
  startedAt: z.string(),
  databaseFile: z.string(),
  recordingsDirectory: z.string(),
  modelFile: z.string(),
  mode: z.enum(['missing', 'failed', 'unavailable']),
  delayMs: z.number().int().nonnegative(),
  inventory: inventorySchema,
  records: z.array(z.object({
    id: z.string(),
    timestamp: z.string(),
    durationMs: z.number().nonnegative(),
    voicedMs: z.number().nonnegative(),
    reviewed: z.boolean(),
    status: z.string().nullable(),
    version: z.string().nullable(),
  })),
})
const progressSchema = z.object({
  next: z.number().int().nonnegative(),
  phase: z.enum(['ready', 'running', 'paused', 'complete', 'failed']),
  backupFile: z.string().nullable(),
  counts: z.object({ ready: z.number(), failed: z.number(), unavailable: z.number(), skipped: z.number() }),
  updatedAt: z.string(),
  error: z.string().optional(),
})
type Manifest = z.infer<typeof manifestSchema>
type Progress = z.infer<typeof progressSchema>

export interface EmbeddingBackfillOptions {
  databaseFile: string
  recordingsDirectory: string
  modelFile: string
  outputDirectory?: string
  dryRun?: boolean
  mode?: BackfillMode
  limit?: number
  delayMs?: number
  signal?: AbortSignal
  log?: (message: string) => void
}

// A small per-database/version/mode pointer makes task directories an internal
// detail. If task files were removed, a new inventory safely skips saved data.
async function activeTask(options: EmbeddingBackfillOptions, root: string) {
  const identity = {
    databaseFile: await realpath(options.databaseFile),
    recordingsDirectory: await realpath(options.recordingsDirectory),
    modelFile: resolve(options.modelFile),
    version: SPEAKER_VERSION,
    mode: options.mode ?? 'missing',
  }
  const key = createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 24)
  const pointer = join(root, `active-${key}.json`)
  if (!options.dryRun) {
    try {
      const { directory } = z.object({ directory: z.string() }).parse(JSON.parse(await readFile(pointer, 'utf8')))
      const manifest = manifestSchema.parse(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')))
      const progress = progressSchema.parse(JSON.parse(await readFile(join(directory, 'progress.json'), 'utf8')))
      if (Object.entries(identity).every(([name, value]) => manifest[name as keyof Manifest] === value)
        && progress.phase !== 'complete' && progress.next < manifest.records.length) {
        return { pointer, directory }
      }
    }
    catch (error) {
      if (isPermissionError(error))
        throw error
      // Missing/stale state never requires the operator to locate a directory.
    }
  }
  return { pointer, directory: undefined }
}

async function atomicJson(filename: string, value: unknown): Promise<void> {
  const temporary = `${filename}.${process.pid}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, filename)
  }
  finally {
    await rm(temporary, { force: true })
  }
}

function fileErrorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined
}

function isPermissionError(error: unknown): boolean {
  return ['EACCES', 'EPERM', 'EIO', 'EMFILE', 'ENFILE', 'ENOSPC', 'EROFS'].includes(fileErrorCode(error) ?? '')
}

async function inventory(options: EmbeddingBackfillOptions): Promise<Manifest> {
  const databaseFile = await realpath(options.databaseFile)
  const recordingsDirectory = await realpath(options.recordingsDirectory)
  if (!(await stat(recordingsDirectory)).isDirectory())
    throw new Error('Recordings root is not a directory')
  const store = new EmbeddingBackfillStore(databaseFile, true)
  const startedAt = new Date().toISOString()
  const summary = { records: 0, recordingSeconds: 0, filesPresent: 0, filesMissing: 0, filesInvalid: 0, voicedTooShort: 0, eligible: 0, eligibleSeconds: 0, otherVersion: 0, statusCounts: {} as Record<string, number> }
  const records: BackfillRecord[] = []
  let after: { timestamp: string, id: string } | undefined
  try {
    while (true) {
      options.signal?.throwIfAborted()
      const page = store.page(startedAt, after)
      if (page.length === 0)
        break
      for (let offset = 0; offset < page.length; offset += 8) {
        const group = page.slice(offset, offset + 8)
        const files = await Promise.all(group.map(async (record) => {
          try {
            return (await stat(speakerWavFile(recordingsDirectory, record))).isFile() ? 'present' : 'invalid'
          }
          catch (error) {
            if (isPermissionError(error))
              throw error
            if (fileErrorCode(error) === 'ENOENT')
              return 'missing'
            if (fileErrorCode(error))
              throw error
            return 'invalid'
          }
        }))
        for (const [i, record] of group.entries()) {
          summary.records++
          summary.recordingSeconds += record.durationMs / 1000
          const status = record.status ?? 'missing_embedding'
          summary.statusCounts[status] = (summary.statusCounts[status] ?? 0) + 1
          if (record.version !== null && record.version !== SPEAKER_VERSION)
            summary.otherVersion++
          if (record.voicedMs < 1000)
            summary.voicedTooShort++
          if (files[i] === 'present')
            summary.filesPresent++
          else if (files[i] === 'missing')
            summary.filesMissing++
          else
            summary.filesInvalid++
          if (eligibleForBackfill(record, options.mode ?? 'missing', SPEAKER_VERSION)) {
            records.push(record)
            summary.eligible++
            summary.eligibleSeconds += record.durationMs / 1000
          }
        }
      }
      const last = page.at(-1)!
      after = { timestamp: last.timestamp, id: last.id }
      if (summary.records % 1000 === 0)
        options.log?.(`盘点 ${summary.records} 条，待补算 ${summary.eligible} 条`)
    }
    return {
      format: 2,
      version: SPEAKER_VERSION,
      startedAt,
      databaseFile,
      recordingsDirectory,
      modelFile: resolve(options.modelFile),
      mode: options.mode ?? 'missing',
      delayMs: options.delayMs ?? 100,
      inventory: summary,
      records,
    }
  }
  finally { store.close() }
}

// Exclusive per-database backfill process. Online recording is never locked by
// this file. A stale lock can be reclaimed on the same host after a hard exit.
async function acquireLock(filename: string): Promise<() => Promise<void>> {
  const contents = JSON.stringify({ pid: process.pid, host: hostname(), token: randomUUID() })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(filename, contents, { flag: 'wx', mode: 0o600 })
      return async () => {
        if (await readFile(filename, 'utf8').catch(() => '') === contents)
          await rm(filename, { force: true })
      }
    }
    catch (error) {
      if (fileErrorCode(error) !== 'EEXIST')
        throw error
      const previous = await readFile(filename, 'utf8')
      const owner = z.object({ pid: z.number().int().positive(), host: z.string() }).parse(JSON.parse(previous))
      let alive = true
      if (owner.host === hostname()) {
        try {
          process.kill(owner.pid, 0)
        }
        catch (checkError) { alive = fileErrorCode(checkError) !== 'ESRCH' }
      }
      if (alive || attempt !== 0)
        throw new Error(`Another backfill owns ${filename}; for a stale lock on another host/container, verify its process has stopped before removing it`)
      if (await readFile(filename, 'utf8') === previous)
        await rm(filename)
    }
  }
  throw new Error('Could not acquire backfill lock')
}

async function createBackup(store: EmbeddingBackfillStore, directory: string, signal?: AbortSignal): Promise<string> {
  const target = join(directory, 'backup.sqlite')
  const temporary = join(directory, 'backup.tmp.sqlite')
  try {
    await backup(store.database, temporary, { rate: 100 })
    signal?.throwIfAborted()
    const inspect = new DatabaseSync(temporary, { readOnly: true })
    try {
      if (inspect.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok')
        throw new Error('Backfill backup integrity check failed')
    }
    finally { inspect.close() }
    await rename(temporary, target)
    return target
  }
  finally { await rm(temporary, { force: true }) }
}

function sqliteBusy(error: unknown): boolean {
  return error instanceof Error && (
    ('errcode' in error && [5, 6].includes(Number(error.errcode) & 0xFF))
    || /SQLITE_BUSY|SQLITE_LOCKED|database (?:table )?is locked/.test(error.message)
  )
}

async function commitBatch(store: EmbeddingBackfillStore, batch: BackfillResult[], manifest: Manifest, signal?: AbortSignal): Promise<BackfillResult[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      return store.commit(batch, manifest.mode)
    }
    catch (error) {
      if (!sqliteBusy(error) || attempt >= 4)
        throw error
      await sleep(100 * 2 ** attempt, undefined, signal ? { signal } : {})
    }
  }
}

export async function runEmbeddingBackfill(options: EmbeddingBackfillOptions) {
  const log = options.log ?? console.log
  const root = resolve(options.outputDirectory ?? join(dirname(await realpath(options.databaseFile)), 'embedding-backfill'))
  const active = await activeTask(options, root)
  const resumeDirectory = active.directory
  const resuming = resumeDirectory !== undefined
  const directory = resumeDirectory
    ? await realpath(resumeDirectory)
    : join(root, `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const manifestFile = join(directory, 'manifest.json')
  const progressFile = join(directory, 'progress.json')
  const manifest = resuming
    ? manifestSchema.parse(JSON.parse(await readFile(manifestFile, 'utf8')))
    : await inventory({ ...options, log })
  let progress: Progress = resuming
    ? progressSchema.parse(JSON.parse(await readFile(progressFile, 'utf8')))
    : { next: 0, phase: 'ready', backupFile: null, counts: { ready: 0, failed: 0, unavailable: 0, skipped: 0 }, updatedAt: new Date().toISOString() }
  if (progress.next > manifest.records.length)
    throw new Error('Invalid backfill checkpoint')
  if (!resuming) {
    await atomicJson(manifestFile, manifest)
    await atomicJson(progressFile, progress)
  }
  await atomicJson(active.pointer, { directory })
  if (resuming)
    log(`自动续跑：已提交 ${progress.next}/${manifest.records.length} 条`)
  log(`补算任务目录：${directory}`)
  log(JSON.stringify(manifest.inventory, null, 2))
  if (options.dryRun)
    return { directory, inventory: manifest.inventory, progress }
  if (progress.phase === 'complete' || progress.next >= manifest.records.length) {
    progress.phase = 'complete'
    await atomicJson(progressFile, progress)
    return { directory, inventory: manifest.inventory, progress }
  }

  const lockFile = `${manifest.databaseFile}.embedding-backfill.lock`
  const release = await acquireLock(lockFile)
  let store: EmbeddingBackfillStore | undefined
  let extractor: SpeakerExtractor | undefined
  const stop = () => extractor?.stop()
  options.signal?.addEventListener('abort', stop, { once: true })
  let batch: BackfillResult[] = []
  const started = performance.now()
  let initialNext = progress.next
  let consecutiveExtractionErrors = 0

  const checkpoint = async () => {
    if (batch.length === 0)
      return
    const committed = await commitBatch(store!, batch, manifest, options.signal)
    // Database commits precede progress files. Replaying after a crash skips
    // already-finished records and safely repeats any uncommitted audio.
    const entries = committed.map(({ voiceprint: _voiceprint, ...entry }) => ({ ...entry, at: new Date().toISOString() }))
    await appendFile(join(directory, 'results.jsonl'), `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`, { mode: 0o600 })
    for (const result of committed)
      progress.counts[result.outcome]++
    progress.next = committed.at(-1)!.index + 1
    progress.updatedAt = new Date().toISOString()
    batch = []
    await atomicJson(progressFile, progress)
  }

  try {
    // Re-read the checkpoint under the process lock before resuming writes.
    if (resuming) {
      progress = progressSchema.parse(JSON.parse(await readFile(progressFile, 'utf8')))
      if (progress.next > manifest.records.length)
        throw new Error('Invalid backfill checkpoint')
      initialNext = progress.next
    }
    options.signal?.throwIfAborted()
    // Resolve the database again to detect a changed symlink on resume.
    if (await realpath(manifest.databaseFile) !== manifest.databaseFile)
      throw new Error('Backfill database path changed')
    const model = await readFile(manifest.modelFile)
    if (createHash('sha256').update(model).digest('hex') !== SPEAKER_MODEL_SHA256)
      throw new Error('Speaker model SHA-256 mismatch')
    store = new EmbeddingBackfillStore(manifest.databaseFile, false)
    if (!progress.backupFile) {
      log('创建并检查数据库一致性备份…')
      progress.backupFile = await createBackup(store, directory, options.signal)
      await atomicJson(progressFile, progress)
    }
    else {
      await stat(progress.backupFile)
    }
    extractor = new SpeakerExtractor(manifest.modelFile)
    progress.phase = 'running'
    delete progress.error
    await atomicJson(progressFile, progress)
    const last = Math.min(manifest.records.length, progress.next + (options.limit ?? manifest.records.length))
    const delayMs = options.delayMs ?? manifest.delayMs
    for (let index = progress.next; index < last; index++) {
      if (options.signal?.aborted)
        break
      const record = manifest.records[index]!
      const current = store.current(record.id)
      let result: BackfillResult
      let fatal: unknown
      if (!current || !eligibleForBackfill(current, manifest.mode, SPEAKER_VERSION)) {
        result = { index, id: record.id, outcome: 'skipped', reason: !current ? 'record_deleted' : !current.reviewed ? 'not_reviewed' : 'existing_embedding' }
      }
      else {
        try {
          const filename = speakerWavFile(manifest.recordingsDirectory, record)
          if (record.voicedMs < 1000) {
            result = { index, id: record.id, outcome: 'unavailable', reason: 'insufficient_voiced_audio', voiceprint: { status: 'unavailable', version: SPEAKER_VERSION, reason: 'insufficient_voiced_audio' } }
          }
          else {
            const samples = await readSpeakerWav(filename, options.signal)
            try {
              const voiceprint = await extractor.extract(samples, record.voicedMs)
              if (voiceprint.status === 'pending' || voiceprint.status === 'failed')
                throw new Error('Unexpected extraction status')
              result = { index, id: record.id, outcome: voiceprint.status, reason: voiceprint.status === 'ready' ? 'extracted' : voiceprint.reason ?? 'insufficient_audio', voiceprint }
              consecutiveExtractionErrors = 0
            }
            catch (error) {
              if (options.signal?.aborted)
                break
              const reason = `extraction_error: ${error instanceof Error ? error.message : String(error)}`
              result = { index, id: record.id, outcome: 'failed', reason, voiceprint: { status: 'failed', version: SPEAKER_VERSION, reason } }
              if (extractor.backingOff || ++consecutiveExtractionErrors >= 3)
                fatal = error
            }
          }
        }
        catch (error) {
          if (options.signal?.aborted)
            break
          if (isPermissionError(error))
            throw error
          const missing = fileErrorCode(error) === 'ENOENT'
          const reason = missing ? 'audio_missing' : `audio_error: ${error instanceof Error ? error.message : String(error)}`
          result = { index, id: record.id, outcome: missing ? 'unavailable' : 'failed', reason, voiceprint: { status: missing ? 'unavailable' : 'failed', version: SPEAKER_VERSION, reason } }
        }
      }
      batch.push(result)
      if (batch.length >= 50 || fatal || index + 1 === last)
        await checkpoint()
      if (fatal)
        throw new Error('Speaker worker unavailable; backfill paused instead of failing remaining records', { cause: fatal })
      if ((index + 1) % 100 === 0) {
        const rate = (index + 1 - initialNext) / ((performance.now() - started) / 1000)
        log(`进度 ${index + 1}/${manifest.records.length}，${rate.toFixed(2)} 条/秒，剩余约 ${Math.ceil((manifest.records.length - index - 1) / rate / 60)} 分钟`)
      }
      if (delayMs > 0 && index + 1 < last && !options.signal?.aborted)
        await sleep(delayMs, undefined, options.signal ? { signal: options.signal } : {})
    }
    await checkpoint()
    progress.phase = progress.next >= manifest.records.length ? 'complete' : 'paused'
    progress.updatedAt = new Date().toISOString()
    await atomicJson(progressFile, progress)
    const coverage = store.coverage(manifest.records.map(record => record.id), SPEAKER_VERSION)
    await atomicJson(join(directory, 'coverage.json'), { at: new Date().toISOString(), candidates: manifest.records.length, ...coverage })
    log(JSON.stringify(progress, null, 2))
    log(`当前候选的数据库覆盖情况：${JSON.stringify(coverage)}`)
    return { directory, inventory: manifest.inventory, progress }
  }
  catch (error) {
    // Even on permission/model failure, preserve previously computed results.
    // On a failed DB write the old checkpoint remains authoritative on resume.
    let checkpointError: unknown
    if (store && batch.length > 0) {
      try {
        await checkpoint()
      }
      catch (failure) { checkpointError = failure }
    }
    progress.phase = options.signal?.aborted ? 'paused' : 'failed'
    progress.updatedAt = new Date().toISOString()
    progress.error = String(checkpointError ?? error)
    await atomicJson(progressFile, progress)
    if (!options.signal?.aborted)
      throw error
    return { directory, inventory: manifest.inventory, progress }
  }
  finally {
    options.signal?.removeEventListener('abort', stop)
    extractor?.stop()
    try {
      store?.close()
    }
    finally {
      await release()
    }
  }
}
