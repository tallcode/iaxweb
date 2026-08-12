import type { SegmentRecord } from './segment-store.js'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export interface ManualReviewPatch {
  callsign?: string | null
  note?: string | null
  riskLevel?: number | null
}

export interface PersistedSegment {
  callsign: string | null
  capturedAt: string
  corrected: string | null
  createdAt: string
  durationMs: number
  effectiveCallsign: string | null
  effectiveRiskLevel: number | null
  id: string
  manualCallsign: string | null
  manualNote: string | null
  manualRiskLevel: number | null
  nodeId: string
  recognition: string
  revise: string | null
  riskLevel: number | null
  riskReason: string | null
  voicedMs: number
}

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
export class SegmentRepository {
  private readonly database: DatabaseSync

  constructor(databaseFile: string) {
    if (databaseFile !== ':memory:')
      mkdirSync(dirname(databaseFile), { recursive: true })
    this.database = new DatabaseSync(databaseFile, { timeout: 5_000 })
    this.database.exec('PRAGMA journal_mode = WAL')
    this.database.exec(SCHEMA)
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

  find(id: string): PersistedSegment | undefined {
    const row = this.database.prepare(SELECT_EFFECTIVE).get(id)
    return row ? mapRow(row) : undefined
  }
}

function mapRow(row: Record<string, unknown>): PersistedSegment {
  return {
    callsign: nullableString(row.callsign),
    capturedAt: requiredString(row.captured_at),
    corrected: nullableString(row.corrected),
    createdAt: requiredString(row.created_at),
    durationMs: requiredNumber(row.duration_ms),
    effectiveCallsign: nullableString(row.effective_callsign),
    effectiveRiskLevel: nullableNumber(row.effective_risk_level),
    id: requiredString(row.id),
    manualCallsign: nullableString(row.manual_callsign),
    manualNote: nullableString(row.manual_note),
    manualRiskLevel: nullableNumber(row.manual_risk_level),
    nodeId: requiredString(row.node_id),
    recognition: requiredString(row.recognition),
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
