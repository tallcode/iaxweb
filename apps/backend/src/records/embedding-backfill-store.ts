import type { StatementSync } from 'node:sqlite'
import type { Voiceprint } from './types.js'
import { DatabaseSync } from 'node:sqlite'
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
}

// Dedicated connection: never run application startup recovery or reset pending
// rows belonging to the online service. The schema must already be deployed.
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
        if (!this.database.prepare('PRAGMA table_info(ai_segment_embeddings)').all().some(row => row.name === 'reason'))
          throw new Error('Deploy the embedding quality schema before backfilling; dry-run is available on legacy databases')
        if (this.database.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'wal')
          throw new Error('Backfill requires WAL mode; deploy the application schema first')
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

  current(id: string): { status: string | null, version: string | null, reviewed: boolean } | undefined {
    this.currentQuery ??= this.database.prepare(`
      SELECT e.status, e.version, s.reviewed FROM ai_segments s
      LEFT JOIN ai_segment_embeddings e ON e.record_id = s.id WHERE s.id = ?
    `)
    const row = this.currentQuery.get(id)
    if (!row)
      return undefined
    return { status: typeof row.status === 'string' ? row.status : null, version: typeof row.version === 'string' ? row.version : null, reviewed: row.reviewed === 1 }
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
      ? 'ON CONFLICT(record_id) DO NOTHING'
      : `ON CONFLICT(record_id) DO UPDATE SET
          version = excluded.version, status = excluded.status, embedding = excluded.embedding, reason = excluded.reason
         WHERE ai_segment_embeddings.status = ? AND ai_segment_embeddings.version = excluded.version`
    const statement = this.writeQueries.get(mode) ?? this.database.prepare(`
      INSERT INTO ai_segment_embeddings (record_id, version, status, embedding, reason)
      SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM ai_segments WHERE id = ? AND reviewed = 1)
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
        const changes = statement.run(result.id, voiceprint.version, voiceprint.status, encodeVoiceprint(voiceprint), voiceprint.reason ?? null, result.id, ...(mode === 'missing' ? [] : [mode])).changes
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
    ? record.status === null
    : record.status === mode && record.version === version)
}
