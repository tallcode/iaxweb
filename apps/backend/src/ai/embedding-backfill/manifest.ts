import type { BackfillMode, BackfillRecord } from '../../records/embedding-backfill-store.js'
import { realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import { eligibleForBackfill, EmbeddingBackfillStore } from '../../records/embedding-backfill-store.js'
import { SPEAKER_VERSION } from '../speaker-model.mjs'
import { speakerWavFile } from '../speaker-wav.js'
import { fileErrorCode, isPermissionError } from './files.js'

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
export const manifestSchema = z.object({
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

export type BackfillManifest = z.infer<typeof manifestSchema>

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

export async function buildBackfillManifest(options: EmbeddingBackfillOptions): Promise<BackfillManifest> {
  const databaseFile = await realpath(options.databaseFile)
  const recordingsDirectory = await realpath(options.recordingsDirectory)
  if (!(await stat(recordingsDirectory)).isDirectory())
    throw new Error('Recordings root is not a directory')
  const store = new EmbeddingBackfillStore(databaseFile, true)
  const startedAt = new Date().toISOString()
  const summary = {
    records: 0,
    recordingSeconds: 0,
    filesPresent: 0,
    filesMissing: 0,
    filesInvalid: 0,
    voicedTooShort: 0,
    eligible: 0,
    eligibleSeconds: 0,
    otherVersion: 0,
    statusCounts: {} as Record<string, number>,
  }
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
