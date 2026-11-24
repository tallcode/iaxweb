import type { AudioQuality } from '@iaxweb/contracts'
import type { StatementSync } from 'node:sqlite'
import type { Voiceprint } from './types.js'
import { DatabaseSync } from 'node:sqlite'
import { SPEAKER_DIMENSIONS } from '../ai/speaker-model.mjs'
import { isQualityReason, parseAudioQuality, storeAudioQuality, voiceprintQuality } from './audio-quality.js'
import { encodeVoiceprint } from './voiceprint.js'

export type BackfillMode = 'missing' | 'failed' | 'unavailable'

export interface BackfillRecord {
  id: string
  timestamp: string
  durationMs: number
  voicedMs: number
  reviewed: boolean
  status: string | null
  version: string | null
}

export interface BackfillResult {
  index: number
  id: string
  outcome: 'ready' | 'failed' | 'unavailable' | 'skipped'
  reason: string
  voiceprint?: Voiceprint | undefined
  previousVersion?: string | null | undefined
  audioQuality?: AudioQuality | undefined
}

// This connection consumes the schema initialized by the server.
export class EmbeddingBackfillStore {
  readonly database: DatabaseSync
  readonly hasEmbeddings: boolean
  private currentQuery: StatementSync | undefined
  private readonly writeQueries = new Map<BackfillMode, StatementSync>()

  constructor(filename: string, private readonly readOnly: boolean) {
    this.database = new DatabaseSync(filename, { readOnly, timeout: 5_000 })
    try {
      if (!this.database.prepare('SELECT 1 FROM sqlite_master WHERE type = \'table\' AND name = \'ai_segments\'').get())
        throw new Error('Database has no ai_segments table')
      this.hasEmbeddings = Boolean(this.database.prepare('SELECT 1 FROM sqlite_master WHERE type = \'table\' AND name = \'ai_segment_embeddings\'').get())
      if (!readOnly) {
        if (!this.hasEmbeddings)
          throw new Error('Deploy the embedding schema before backfilling; dry-run is available on legacy databases')
        this.database.exec('PRAGMA journal_mode = WAL')
        this.database.exec('PRAGMA foreign_keys = ON')
      }
    }
    catch (error) {
      this.database.close()
      throw error
    }
  }

  close(): void {
    this.database.close()
  }

  updateAudioQuality(id: string, quality: AudioQuality): void {
    if (this.readOnly)
      throw new Error('Cannot update quality in a dry-run')
    storeAudioQuality(this.database, id, quality)
  }

  page(cutoff: string, after?: { timestamp: string, id: string }): BackfillRecord[] {
    const rows = this.database.prepare(`
      SELECT s.id, s.captured_at, s.duration_ms, s.voiced_ms, s.reviewed,
        ${this.hasEmbeddings ? 'e.status, e.version' : 'NULL AS status, NULL AS version'}
      FROM ai_segments s
      ${this.hasEmbeddings ? 'LEFT JOIN ai_segment_embeddings e ON e.record_id = s.id' : ''}
      WHERE s.created_at <= ? AND s.reviewed = 1
        ${after ? 'AND (s.captured_at, s.id) > (?, ?)' : ''}
      ORDER BY s.captured_at, s.id LIMIT 100
    `).all(cutoff, ...(after ? [after.timestamp, after.id] : []))
    return rows.map((row) => {
      if (typeof row.id !== 'string' || typeof row.captured_at !== 'string'
        || typeof row.duration_ms !== 'number' || typeof row.voiced_ms !== 'number') {
        throw new TypeError('Malformed source record in ai_segments')
      }
      return {
        id: row.id,
        timestamp: row.captured_at,
        durationMs: row.duration_ms,
        voicedMs: row.voiced_ms,
        reviewed: row.reviewed === 1,
        status: typeof row.status === 'string' ? row.status : null,
        version: typeof row.version === 'string' ? row.version : null,
      }
    })
  }

  current(id: string): { status: string | null, version: string | null, reviewed: boolean, gateVersion?: AudioQuality['gateVersion'] } | undefined {
    this.currentQuery ??= this.database.prepare(`
      SELECT e.status, e.version, s.reviewed, s.audio_quality FROM ai_segments s
      LEFT JOIN ai_segment_embeddings e ON e.record_id = s.id WHERE s.id = ?
    `)
    const row = this.currentQuery.get(id)
    if (!row)
      return undefined
    const gateVersion = parseAudioQuality(row.audio_quality)?.gateVersion
    return {
      status: typeof row.status === 'string' ? row.status : null,
      version: typeof row.version === 'string' ? row.version : null,
      reviewed: row.reviewed === 1,
      ...(gateVersion === undefined ? {} : { gateVersion }),
    }
  }

  coverage(ids: readonly string[], version: string) {
    const counts = { ready: 0, failed: 0, unavailable: 0, pending: 0, missingEmbedding: 0, deleted: 0, otherVersion: 0 }
    for (let offset = 0; offset < ids.length; offset += 100) {
      const group = ids.slice(offset, offset + 100)
      const rows = this.database.prepare(`
        SELECT e.status, e.version FROM ai_segments s
        LEFT JOIN ai_segment_embeddings e ON e.record_id = s.id
        WHERE s.id IN (${group.map(() => '?').join(',')})
      `).all(...group)
      counts.deleted += group.length - rows.length
      for (const row of rows) {
        if (row.version === null)
          counts.missingEmbedding++
        else if (row.version !== version)
          counts.otherVersion++
        else if (row.status === 'ready' || row.status === 'failed' || row.status === 'unavailable' || row.status === 'pending')
          counts[row.status]++
      }
    }
    return counts
  }

  // Guard each write again inside the short transaction. A concurrently
  // deleted record or completed/pending embedding is never recreated/overwritten.
  commit(results: BackfillResult[], mode: BackfillMode): BackfillResult[] {
    if (this.readOnly)
      throw new Error('Cannot commit a dry-run')
    if (results.every(result => !result.voiceprint))
      return results
    const retryClause = mode === 'missing'
      ? `ON CONFLICT(record_id) DO UPDATE SET
          version = excluded.version, dimensions = excluded.dimensions,
          status = excluded.status, embedding = excluded.embedding, reason = excluded.reason
         WHERE ai_segment_embeddings.version = ? AND ai_segment_embeddings.version != excluded.version`
      : `ON CONFLICT(record_id) DO UPDATE SET
          version = excluded.version, dimensions = excluded.dimensions,
          status = excluded.status, embedding = excluded.embedding, reason = excluded.reason
         WHERE ai_segment_embeddings.status = ? AND ai_segment_embeddings.version = excluded.version`
    const statement = this.writeQueries.get(mode) ?? this.database.prepare(`
      INSERT INTO ai_segment_embeddings (record_id, version, dimensions, status, embedding, reason)
      SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM ai_segments WHERE id = ? AND reviewed = 1)
      ${retryClause}
    `)
    this.writeQueries.set(mode, statement)
    let began = false
    try {
      this.database.exec('BEGIN IMMEDIATE')
      began = true
      const committed = results.map((result) => {
        if (!result.voiceprint)
          return result
        const voiceprint = result.voiceprint
        const changes = statement.run(result.id, voiceprint.version, SPEAKER_DIMENSIONS, voiceprint.status, encodeVoiceprint(voiceprint), isQualityReason(voiceprint.reason) ? null : voiceprint.reason ?? null, result.id, mode === 'missing' ? result.previousVersion ?? null : mode).changes
        if (Number(changes) === 1) {
          const quality = result.audioQuality ?? voiceprintQuality(voiceprint)
          if (quality)
            storeAudioQuality(this.database, result.id, quality, !result.audioQuality && voiceprint.status === 'ready')
        }
        return Number(changes) === 1 ? result : { ...result, outcome: 'skipped' as const, reason: 'record_or_embedding_changed', voiceprint: undefined }
      })
      this.database.exec('COMMIT')
      return committed
    }
    catch (error) {
      if (began) {
        try {
          this.database.exec('ROLLBACK')
        }
        catch { /* Preserve the original database error after an automatic rollback. */ }
      }
      throw error
    }
  }
}

export function eligibleForBackfill(record: { status: string | null, version: string | null, reviewed: boolean }, mode: BackfillMode, version: string): boolean {
  return record.reviewed && (mode === 'missing'
    ? record.status === null || record.version !== version
    : record.status === mode && record.version === version)
}
