import type { BackfillResult } from '../records/embedding-backfill-store.js'
import type { Voiceprint } from '../records/types.js'
import type { EmbeddingBackfillOptions } from './embedding-backfill/manifest.js'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import { eligibleForBackfill, EmbeddingBackfillStore } from '../records/embedding-backfill-store.js'
import { AudioQualityService } from './audio-quality.js'
import { commitBackfillBatch, createBackfillBackup } from './embedding-backfill/database.js'
import { acquireBackfillLock, fileErrorCode, isPermissionError, writeBackfillJson } from './embedding-backfill/files.js'
import { appendBackfillResults, openBackfillTask, readBackfillProgress } from './embedding-backfill/task-files.js'
import { SPEAKER_MODEL_SHA256, SPEAKER_VERSION } from './speaker-model.mjs'
import { SPEAKER_RESOURCE_LIMIT_REASON } from './speaker-resources.js'
import { readSpeakerWav, speakerWavFile } from './speaker-wav.js'
import { SpeakerExtractor } from './speaker.js'

export type { EmbeddingBackfillOptions } from './embedding-backfill/manifest.js'

export async function runEmbeddingBackfill(options: EmbeddingBackfillOptions) {
  const log = options.log ?? console.log
  const { directory, manifest, progressFile, progress: initialProgress, resuming } = await openBackfillTask({ ...options, log })
  let progress = initialProgress
  if (resuming)
    log(`自动续跑：已提交 ${progress.next}/${manifest.records.length} 条`)
  log(`补算任务目录：${directory}`)
  log(JSON.stringify(manifest.inventory, null, 2))
  if (options.dryRun)
    return { directory, inventory: manifest.inventory, progress }
  if (progress.phase === 'complete' || progress.next >= manifest.records.length) {
    progress.phase = 'complete'
    await writeBackfillJson(progressFile, progress)
    return { directory, inventory: manifest.inventory, progress }
  }

  const lockFile = `${manifest.databaseFile}.embedding-backfill.lock`
  const release = await acquireBackfillLock(lockFile)
  let store: EmbeddingBackfillStore | undefined
  let extractor: SpeakerExtractor | undefined
  const audioQuality = new AudioQualityService()
  const stop = () => {
    extractor?.stop()
    audioQuality.stop()
  }
  options.signal?.addEventListener('abort', stop, { once: true })
  let batch: BackfillResult[] = []
  const started = performance.now()
  let initialNext = progress.next
  let consecutiveExtractionErrors = 0

  const checkpoint = async () => {
    if (batch.length === 0)
      return
    const committed = await commitBackfillBatch(store!, batch, manifest.mode, options.signal)
    // Database commits precede progress files. Replaying after a crash skips
    // already-finished records and safely repeats any uncommitted audio.
    await appendBackfillResults(directory, committed)
    for (const result of committed)
      progress.counts[result.outcome]++
    progress.next = committed.at(-1)!.index + 1
    progress.updatedAt = new Date().toISOString()
    batch = []
    await writeBackfillJson(progressFile, progress)
  }

  try {
    // Re-read the checkpoint under the process lock before resuming writes.
    if (resuming) {
      progress = await readBackfillProgress(progressFile, manifest.records.length)
      initialNext = progress.next
    }
    options.signal?.throwIfAborted()
    // Resolve the database again to detect a changed symlink on resume.
    if (await realpath(manifest.databaseFile) !== manifest.databaseFile)
      throw new Error('Backfill database path changed')
    const modelHash = createHash('sha256')
    for await (const chunk of createReadStream(manifest.modelFile))
      modelHash.update(chunk)
    if (modelHash.digest('hex') !== SPEAKER_MODEL_SHA256)
      throw new Error('Speaker model SHA-256 mismatch')
    store = new EmbeddingBackfillStore(manifest.databaseFile, false)
    if (!progress.backupFile) {
      log('创建并检查数据库一致性备份…')
      progress.backupFile = await createBackfillBackup(store, directory, options.signal)
      await writeBackfillJson(progressFile, progress)
    }
    else {
      await stat(progress.backupFile)
    }
    extractor = new SpeakerExtractor(manifest.modelFile)
    progress.phase = 'running'
    delete progress.error
    await writeBackfillJson(progressFile, progress)
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
          const samples = await readSpeakerWav(filename, options.signal)
          try {
            const quality = await audioQuality.check(samples, options.signal)
            if (options.signal?.aborted)
              break
            store.updateAudioQuality(record.id, quality)
            const voiceprint: Voiceprint = quality.status === 'passed'
              ? await extractor.extract(samples, record.voicedMs, options.signal, undefined, true)
              : { status: 'unavailable', version: SPEAKER_VERSION } as const
            if (voiceprint.status === 'pending' || voiceprint.status === 'failed')
              throw new Error('Unexpected extraction status')
            result = { index, id: record.id, outcome: voiceprint.status, reason: voiceprint.status === 'ready' ? 'extracted' : quality.reason ?? voiceprint.reason ?? 'insufficient_audio', voiceprint, audioQuality: quality }
            consecutiveExtractionErrors = 0
          }
          catch (error) {
            if (options.signal?.aborted)
              break
            const reason = `extraction_error: ${error instanceof Error ? error.message : String(error)}`
            if (reason.includes('resource limit'))
              result = { index, id: record.id, outcome: 'unavailable', reason: SPEAKER_RESOURCE_LIMIT_REASON, voiceprint: { status: 'unavailable', version: SPEAKER_VERSION, reason: SPEAKER_RESOURCE_LIMIT_REASON } }
            else if (reason.includes('insufficient memory'))
              result = { index, id: record.id, outcome: 'skipped', reason: 'insufficient_memory' }
            else
              result = { index, id: record.id, outcome: 'failed', reason, voiceprint: { status: 'failed', version: SPEAKER_VERSION, reason } }
            if (extractor.backingOff || ++consecutiveExtractionErrors >= 3)
              fatal = error
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
      if (fatal && result.reason === 'insufficient_memory')
        throw new Error('Speaker process has insufficient memory; retry this record after recovery', { cause: fatal })
      if (result.voiceprint)
        result.previousVersion = current?.version ?? null
      batch.push(result)
      if (batch.length >= 50 || fatal || index + 1 === last)
        await checkpoint()
      if (fatal)
        throw new Error('Speaker process unavailable; backfill paused instead of failing remaining records', { cause: fatal })
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
    await writeBackfillJson(progressFile, progress)
    const coverage = store.coverage(manifest.records.map(record => record.id), SPEAKER_VERSION)
    await writeBackfillJson(join(directory, 'coverage.json'), { at: new Date().toISOString(), candidates: manifest.records.length, ...coverage })
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
    await writeBackfillJson(progressFile, progress)
    if (!options.signal?.aborted)
      throw error
    return { directory, inventory: manifest.inventory, progress }
  }
  finally {
    options.signal?.removeEventListener('abort', stop)
    extractor?.stop()
    audioQuality.stop()
    try {
      store?.close()
    }
    finally {
      await release()
    }
  }
}
