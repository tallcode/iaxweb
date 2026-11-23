import type { BackfillResult } from '../../records/embedding-backfill-store.js'
import type { BackfillManifest, EmbeddingBackfillOptions } from './manifest.js'
import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { SPEAKER_VERSION } from '../speaker-model.mjs'
import { isPermissionError, writeBackfillJson } from './files.js'
import { buildBackfillManifest, manifestSchema } from './manifest.js'

const progressSchema = z.object({
  next: z.number().int().nonnegative(),
  phase: z.enum(['ready', 'running', 'paused', 'complete', 'failed']),
  backupFile: z.string().nullable(),
  counts: z.object({ ready: z.number(), failed: z.number(), unavailable: z.number(), skipped: z.number() }),
  updatedAt: z.string(),
  error: z.string().optional(),
})
type BackfillProgress = z.infer<typeof progressSchema>

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
      if (Object.entries(identity).every(([name, value]) => manifest[name as keyof BackfillManifest] === value)
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

export async function openBackfillTask(options: EmbeddingBackfillOptions) {
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
    : await buildBackfillManifest(options)
  const progress: BackfillProgress = resuming
    ? await readBackfillProgress(progressFile, manifest.records.length)
    : {
        next: 0,
        phase: 'ready',
        backupFile: null,
        counts: { ready: 0, failed: 0, unavailable: 0, skipped: 0 },
        updatedAt: new Date().toISOString(),
      }
  if (!resuming) {
    await writeBackfillJson(manifestFile, manifest)
    await writeBackfillJson(progressFile, progress)
  }
  await writeBackfillJson(active.pointer, { directory })
  return { directory, manifest, progressFile, progress, resuming }
}

export async function readBackfillProgress(progressFile: string, recordCount: number) {
  const progress = progressSchema.parse(JSON.parse(await readFile(progressFile, 'utf8')))
  if (progress.next > recordCount)
    throw new Error('Invalid backfill checkpoint')
  return progress
}

export async function appendBackfillResults(directory: string, committed: BackfillResult[]): Promise<void> {
  const entries = committed.map(({ voiceprint: _voiceprint, ...entry }) => ({ ...entry, at: new Date().toISOString() }))
  await appendFile(join(directory, 'results.jsonl'), `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`, { mode: 0o600 })
}
