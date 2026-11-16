import type { PersistedRecord, RecordPage } from '@iaxweb/contracts'
import type { SegmentRecord } from './segment-store.js'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export interface StoredSpot {
  at: string
  callsign: string
  id: string
  node: string
}

export interface ManualReviewPatch {
  calleeCallsign?: string | null
  callsign?: string | null
  recognition?: string | null
  reviewed?: boolean
  note?: string | null
  riskLevel?: number | null
}

export type { PersistedRecord, RecordPage } from '@iaxweb/contracts'

// Keep persisted SQL names stable so existing recording history needs no rename migration.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS ai_segments (
    id                TEXT PRIMARY KEY,
    node_id           TEXT NOT NULL,
    captured_at       TEXT NOT NULL,
    duration_ms       INTEGER NOT NULL CHECK (duration_ms >= 0),
    voiced_ms         INTEGER NOT NULL CHECK (voiced_ms >= 0),

    recognition       TEXT NOT NULL,
    corrected         TEXT,
    revise            TEXT,
    callsign          TEXT COLLATE NOCASE,

    risk_level        INTEGER CHECK (risk_level BETWEEN 1 AND 5),
    risk_reason       TEXT,

    manual_callsign   TEXT COLLATE NOCASE,
    manual_recognition TEXT,
    reviewed          INTEGER NOT NULL DEFAULT 0 CHECK (reviewed IN (0, 1)),
    callee_callsign   TEXT COLLATE NOCASE,
    manual_risk_level INTEGER CHECK (manual_risk_level BETWEEN 1 AND 5),
    manual_note       TEXT,

    created_at        TEXT NOT NULL
                      DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

    CHECK (
      (risk_level IS NULL AND risk_reason IS NULL)
      OR (risk_level IS NOT NULL AND length(trim(risk_reason)) > 0)
    )
  );

  CREATE VIEW IF NOT EXISTS ai_segments_effective AS
  SELECT
    *,
    COALESCE(manual_callsign, callsign) AS effective_callsign,
    COALESCE(manual_risk_level, risk_level) AS effective_risk_level
  FROM ai_segments;
`

const INDEXES = `
  CREATE INDEX IF NOT EXISTS ai_segments_capture_order
    ON ai_segments (captured_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS ai_segments_effective_callsign_order
    ON ai_segments (COALESCE(manual_callsign, callsign) COLLATE NOCASE, captured_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS ai_segments_edited_order
    ON ai_segments (captured_at DESC, id DESC)
    WHERE manual_recognition IS NOT NULL OR manual_callsign IS NOT NULL OR callee_callsign IS NOT NULL;
  CREATE INDEX IF NOT EXISTS ai_segments_reviewed_order
    ON ai_segments (captured_at DESC, id DESC) WHERE reviewed = 1;
`

const SELECT_EFFECTIVE = `
  SELECT
    id,
    node_id,
    captured_at,
    duration_ms,
    voiced_ms,
    recognition,
    corrected,
    revise,
    callsign,
    risk_level,
    risk_reason,
    manual_callsign,
    manual_recognition,
    reviewed,
    callee_callsign,
    manual_risk_level,
    manual_note,
    created_at,
    effective_callsign,
    effective_risk_level
  FROM ai_segments_effective
  WHERE id = ?
`

// SQLite-backed history of successful ASR segments. AI values are immutable
// evidence; manual fields override them only through the effective view.
export class RecordRepository {
  private readonly database: DatabaseSync

  constructor(databaseFile: string) {
    if (databaseFile !== ':memory:')
      mkdirSync(dirname(databaseFile), { recursive: true })
    this.database = new DatabaseSync(databaseFile, { timeout: 5_000 })
    this.database.exec('PRAGMA journal_mode = WAL')
    // Existing databases are upgraded in place; AI evidence is never rewritten.
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database.exec(SCHEMA)
      const columns = new Set(this.database.prepare('PRAGMA table_info(ai_segments)').all().map(row => row.name))
      if (!columns.has('manual_recognition'))
        this.database.exec('ALTER TABLE ai_segments ADD COLUMN manual_recognition TEXT')
      if (!columns.has('reviewed'))
        this.database.exec('ALTER TABLE ai_segments ADD COLUMN reviewed INTEGER NOT NULL DEFAULT 0 CHECK (reviewed IN (0, 1))')
      // Build after adding legacy columns used by the partial indexes.
      this.database.exec(INDEXES)
      this.database.exec('COMMIT')
    }
    catch (error) {
      this.database.exec('ROLLBACK')
      this.database.close()
      throw error
    }
  }

  close(): void {
    this.database.close()
  }

  insert(nodeId: string, record: SegmentRecord): void {
    if (record.recognition === undefined)
      throw new Error('Cannot persist a segment without recognition text')

    this.database.prepare(`
      INSERT INTO ai_segments (
        id, node_id, captured_at, duration_ms, voiced_ms, recognition, corrected
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      nodeId,
      record.timestamp,
      record.durationMs,
      record.voicedMs,
      record.recognition,
      record.corrected ?? null,
    )
  }

  updateAnalysis(record: SegmentRecord): boolean {
    const result = this.database.prepare(`
      UPDATE ai_segments
      SET revise = ?, callsign = ?, risk_level = ?, risk_reason = ?
      WHERE id = ?
    `).run(
      record.revise ?? null,
      record.callsign ?? null,
      record.risk?.level ?? null,
      record.risk?.reason ?? null,
      record.id,
    )
    return Number(result.changes) === 1
  }

  updateManualReview(id: string, patch: ManualReviewPatch): boolean {
    const assignments: string[] = []
    const values: Array<number | string | null> = []
    if (patch.callsign !== undefined) {
      assignments.push('manual_callsign = ?')
      values.push(patch.callsign)
    }
    if (patch.recognition !== undefined) {
      assignments.push('manual_recognition = ?')
      values.push(patch.recognition?.trim() || null)
    }
    if (patch.reviewed !== undefined) {
      assignments.push('reviewed = ?')
      values.push(patch.reviewed ? 1 : 0)
    }
    if (patch.calleeCallsign !== undefined) {
      assignments.push('callee_callsign = ?')
      values.push(patch.calleeCallsign)
    }
    if (patch.riskLevel !== undefined) {
      assignments.push('manual_risk_level = ?')
      values.push(patch.riskLevel)
    }
    if (patch.note !== undefined) {
      assignments.push('manual_note = ?')
      values.push(patch.note)
    }
    if (assignments.length === 0)
      throw new Error('Manual review patch must contain at least one field')

    const result = this.database.prepare(`
      UPDATE ai_segments SET ${assignments.join(', ')} WHERE id = ?
    `).run(...values, id)
    return Number(result.changes) === 1
  }

  find(id: string): PersistedRecord | undefined {
    const row = this.database.prepare(SELECT_EFFECTIVE).get(id)
    return row ? mapRow(row) : undefined
  }

  delete(id: string, removeRecording: () => void): boolean {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = this.database.prepare('DELETE FROM ai_segments WHERE id = ?').run(id)
      if (Number(result.changes) === 0) {
        this.database.exec('ROLLBACK')
        return false
      }
      // Keep the database record when the recording cannot be removed.
      removeRecording()
      this.database.exec('COMMIT')
      return true
    }
    catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  list(page: number, pageSize: number, callsign?: string, editedOnly: boolean = false, reviewedOnly: boolean = false): RecordPage {
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100)
      throw new Error('Invalid segment page')
    const conditions: string[] = []
    const parameters: string[] = []
    if (editedOnly)
      conditions.push('(manual_recognition IS NOT NULL OR manual_callsign IS NOT NULL OR callee_callsign IS NOT NULL)')
    if (reviewedOnly)
      conditions.push('reviewed = 1')
    if (callsign !== undefined) {
      conditions.push('effective_callsign = ? COLLATE NOCASE')
      parameters.push(callsign)
    }
    const whereClause = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`
    const totalRow = this.database.prepare(`
      SELECT COUNT(*) AS total
      FROM ai_segments_effective
      ${whereClause}
    `).get(...parameters)
    const total = requiredNumber(totalRow?.total)
    const rows = this.database.prepare(`
      SELECT
        id, node_id, captured_at, duration_ms, voiced_ms, recognition, corrected,
        revise, callsign, risk_level, risk_reason, manual_callsign, callee_callsign,
        manual_recognition, reviewed, manual_risk_level, manual_note, created_at, effective_callsign,
        effective_risk_level
      FROM ai_segments_effective
      ${whereClause}
      ORDER BY captured_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(...parameters, pageSize, (page - 1) * pageSize)
    return { items: rows.map(mapRow), page, pageSize, total }
  }

  recentSpots(limit: number = 30): StoredSpot[] {
    if (!Number.isInteger(limit) || limit < 1)
      throw new Error('Spot limit must be a positive integer')
    const rows = this.database.prepare(`
      WITH ranked AS (
        SELECT
          id,
          node_id,
          captured_at,
          effective_callsign,
          ROW_NUMBER() OVER (
            PARTITION BY effective_callsign
            ORDER BY captured_at DESC, id DESC
          ) AS row_number
        FROM ai_segments_effective
        WHERE effective_callsign IS NOT NULL
          AND effective_callsign <> 'N0CALL'
      )
      SELECT id, node_id, captured_at, effective_callsign
      FROM ranked
      WHERE row_number = 1
      ORDER BY captured_at DESC, id DESC
      LIMIT ?
    `).all(limit)
    return rows.map(row => ({
      at: requiredString(row.captured_at),
      callsign: requiredString(row.effective_callsign),
      id: requiredString(row.id),
      node: requiredString(row.node_id),
    }))
  }
}

function mapRow(row: Record<string, unknown>): PersistedRecord {
  return {
    calleeCallsign: nullableString(row.callee_callsign),
    callsign: nullableString(row.callsign),
    capturedAt: requiredString(row.captured_at),
    corrected: nullableString(row.corrected),
    createdAt: requiredString(row.created_at),
    durationMs: requiredNumber(row.duration_ms),
    effectiveCallsign: nullableString(row.effective_callsign),
    effectiveRiskLevel: nullableNumber(row.effective_risk_level),
    id: requiredString(row.id),
    manualCallsign: nullableString(row.manual_callsign),
    manualRecognition: nullableString(row.manual_recognition),
    manualNote: nullableString(row.manual_note),
    manualRiskLevel: nullableNumber(row.manual_risk_level),
    nodeId: requiredString(row.node_id),
    recognition: requiredString(row.recognition),
    reviewed: requiredNumber(row.reviewed) === 1,
    revise: nullableString(row.revise),
    riskLevel: nullableNumber(row.risk_level),
    riskReason: nullableString(row.risk_reason),
    voicedMs: requiredNumber(row.voiced_ms),
  }
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string')
    throw new Error('Unexpected non-string SQLite value')
  return value
}

function nullableString(value: unknown): string | null {
  if (value === null)
    return null
  return requiredString(value)
}

function requiredNumber(value: unknown): number {
  if (typeof value !== 'number')
    throw new Error('Unexpected non-number SQLite value')
  return value
}

function nullableNumber(value: unknown): number | null {
  if (value === null)
    return null
  return requiredNumber(value)
}
