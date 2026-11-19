import type { PersistedRecord, RecordPage, SpeakerMatch } from '@iaxweb/contracts'
import type { ReadyVoiceprint, RecognitionRecord, SpeakerReferenceGroup, SpeakerReferenceScore, Voiceprint } from './types.js'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { CALLSIGN_PREFIX_SOURCE, hasCallerCallsign } from '@iaxweb/contracts'
import * as sqliteVec from 'sqlite-vec'
import { SPEAKER_DIMENSIONS, SPEAKER_VERSION } from '../ai/speaker-model.mjs'
import { SPEAKER_REFERENCE_LIMIT } from '../ai/speaker-reference-score.mjs'
import { migrateEmbeddingSchema } from './embedding-schema.js'
import { decodeVoiceprint, encodeVoiceprint } from './voiceprint.js'

export const SPEAKER_REFERENCE_THRESHOLD = 0.80
const TWO_LETTER_CALLSIGN_GLOB = `${CALLSIGN_PREFIX_SOURCE}[0-9][A-Z][A-Z]`
const THREE_LETTER_CALLSIGN_GLOB = `${TWO_LETTER_CALLSIGN_GLOB}[A-Z]`
type SpeakerSearchMatch = Omit<SpeakerMatch, 'confidence' | Exclude<keyof SpeakerReferenceScore, 'callsign'>>

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
    callsign_algorithm TEXT,

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
    callsign_algorithm,
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
  private vectorExtensionLoaded = false

  constructor(databaseFile: string) {
    if (databaseFile !== ':memory:')
      mkdirSync(dirname(databaseFile), { recursive: true })
    this.database = new DatabaseSync(databaseFile, { timeout: 5_000, allowExtension: true })
    // Load the native extension on the first reference search.
    this.database.enableLoadExtension(false)
    this.database.exec('PRAGMA journal_mode = WAL')
    this.database.exec('PRAGMA foreign_keys = ON')
    // Existing databases are upgraded in place; AI evidence is never rewritten.
    let began = false
    try {
      this.database.exec('BEGIN IMMEDIATE')
      began = true
      this.database.exec(SCHEMA)
      const columns = new Set(this.database.prepare('PRAGMA table_info(ai_segments)').all().map(row => row.name))
      if (!columns.has('manual_recognition'))
        this.database.exec('ALTER TABLE ai_segments ADD COLUMN manual_recognition TEXT')
      if (!columns.has('reviewed'))
        this.database.exec('ALTER TABLE ai_segments ADD COLUMN reviewed INTEGER NOT NULL DEFAULT 0 CHECK (reviewed IN (0, 1))')
      if (!columns.has('callsign_algorithm'))
        this.database.exec('ALTER TABLE ai_segments ADD COLUMN callsign_algorithm TEXT')
      migrateEmbeddingSchema(this.database)
      // Build after adding legacy columns used by the partial indexes.
      this.database.exec(INDEXES)
      this.database.exec('COMMIT')
    }
    catch (error) {
      if (began)
        this.database.exec('ROLLBACK')
      this.database.close()
      throw error
    }
  }

  close(): void {
    this.database.close()
  }

  insert(nodeId: string, record: RecognitionRecord): void {
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

  updateVoiceprint(id: string, voiceprint: Voiceprint): boolean {
    return Number(this.database.prepare(`
      UPDATE ai_segment_embeddings SET status = ?, embedding = ?, reason = ?
      WHERE record_id = ? AND version = ? AND status = 'pending'
        AND EXISTS (SELECT 1 FROM ai_segments WHERE id = ? AND reviewed = 1)
    `).run(voiceprint.status, encodeVoiceprint(voiceprint), voiceprint.reason ?? null, id, voiceprint.version, id).changes) === 1
  }

  findReadyVoiceprint(id: string): ReadyVoiceprint | undefined {
    const row = this.database.prepare(`
      SELECT embedding FROM ai_segment_embeddings
      WHERE record_id = ? AND version = ? AND dimensions = ? AND status = 'ready'
    `).get(id, SPEAKER_VERSION, SPEAKER_DIMENSIONS)
    if (!row)
      return undefined
    try {
      return { status: 'ready', version: SPEAKER_VERSION, embedding: decodeVoiceprint(row.embedding) }
    }
    catch { return undefined }
  }

  saveQueryVoiceprint(id: string, voiceprint: ReadyVoiceprint): void {
    if (voiceprint.version !== SPEAKER_VERSION)
      return
    // The record may have been deleted while the worker was extracting.
    this.database.prepare(`
      INSERT INTO ai_segment_embeddings (record_id, version, dimensions, status, embedding)
      SELECT id, ?, ?, 'ready', ? FROM ai_segments WHERE id = ?
      ON CONFLICT(record_id) DO UPDATE SET version = excluded.version, dimensions = excluded.dimensions,
        status = 'ready', embedding = excluded.embedding, reason = NULL
    `).run(voiceprint.version, SPEAKER_DIMENSIONS, encodeVoiceprint(voiceprint), id)
  }

  pendingReviewedVoiceprints(limit: number = 10): Array<{ id: string, timestamp: string, voicedMs: number }> {
    const rows = this.database.prepare(`
      SELECT s.id, s.captured_at, s.voiced_ms FROM ai_segments s
      LEFT JOIN ai_segment_embeddings e ON e.record_id = s.id
      WHERE s.reviewed = 1 AND (e.record_id IS NULL OR e.version != ? OR e.dimensions != ? OR e.status = 'pending')
      ORDER BY s.captured_at, s.id LIMIT ?
    `).all(SPEAKER_VERSION, SPEAKER_DIMENSIONS, limit)
    return rows.map(row => ({ id: requiredString(row.id), timestamp: requiredString(row.captured_at), voicedMs: requiredNumber(row.voiced_ms) }))
  }

  prepareReviewedVoiceprint(id: string): boolean {
    return Number(this.database.prepare(`
      INSERT INTO ai_segment_embeddings (record_id, version, dimensions, status, embedding)
      SELECT id, ?, ?, 'pending', NULL FROM ai_segments WHERE id = ? AND reviewed = 1
      ON CONFLICT(record_id) DO UPDATE SET version = excluded.version, dimensions = excluded.dimensions,
        status = 'pending', embedding = NULL, reason = NULL
      WHERE ai_segment_embeddings.version != excluded.version OR ai_segment_embeddings.dimensions != excluded.dimensions
        OR ai_segment_embeddings.status = 'pending'
    `).run(SPEAKER_VERSION, SPEAKER_DIMENSIONS, id).changes) === 1
  }

  searchSpeakerMatches(voiceprint: Voiceprint, excludeId: string): { referenceCount: number, matches: SpeakerSearchMatch[] } {
    if (voiceprint.status !== 'ready' || voiceprint.version !== SPEAKER_VERSION)
      return { referenceCount: 0, matches: [] }
    this.loadVectorExtension()
    // Exact radius search over the reviewed corpus, not a global top-K followed
    // by filtering. Unreviewed neighbors cannot crowd out eligible references.
    // Group only after scoring so multiple records for one call remain one hint.
    const rows = this.database.prepare(`
      WITH reviewed AS (
        SELECT UPPER(COALESCE(s.manual_callsign, s.callsign)) AS callsign, e.embedding
        FROM ai_segments s JOIN ai_segment_embeddings e ON e.record_id = s.id
        WHERE s.reviewed = 1 AND e.status = 'ready' AND e.version = ? AND e.dimensions = ? AND s.id != ?
          AND COALESCE(s.manual_callsign, s.callsign) IS NOT NULL
      ), eligible AS MATERIALIZED (
        SELECT * FROM reviewed
        WHERE callsign GLOB ? OR callsign GLOB ?
      ), scored AS MATERIALIZED (
        SELECT callsign, MIN(1.0, MAX(-1.0, 1.0 - vec_distance_cosine(embedding, ?))) AS similarity
        FROM eligible
      ), matches AS (
        SELECT callsign, COUNT(*) AS count, MIN(similarity) AS min_similarity,
          MAX(similarity) AS max_similarity, AVG(similarity) AS average_similarity
        FROM scored WHERE similarity > ? GROUP BY callsign
      )
      SELECT matches.*, (SELECT COUNT(*) FROM eligible) AS reference_count
      FROM (SELECT 1) LEFT JOIN matches ON 1 = 1
      ORDER BY count DESC, max_similarity DESC, average_similarity DESC, callsign
    `).all(
      SPEAKER_VERSION,
      SPEAKER_DIMENSIONS,
      excludeId,
      TWO_LETTER_CALLSIGN_GLOB,
      THREE_LETTER_CALLSIGN_GLOB,
      encodeVoiceprint(voiceprint),
      SPEAKER_REFERENCE_THRESHOLD,
    )
    return {
      referenceCount: requiredNumber(rows[0]!.reference_count),
      matches: rows.flatMap(row => row.callsign === null
        ? []
        : [{
            callsign: requiredString(row.callsign),
            count: requiredNumber(row.count),
            minSimilarity: requiredNumber(row.min_similarity),
            maxSimilarity: requiredNumber(row.max_similarity),
            averageSimilarity: requiredNumber(row.average_similarity),
          }]),
    }
  }

  recentSpeakerReferences(callsigns: string[], excludeId: string): SpeakerReferenceGroup[] {
    const query = this.database.prepare(`
      SELECT e.embedding FROM ai_segments s
      JOIN ai_segment_embeddings e ON e.record_id = s.id
      WHERE COALESCE(s.manual_callsign, s.callsign) COLLATE NOCASE = ?
        AND s.reviewed = 1 AND e.status = 'ready' AND e.version = ?
        AND e.dimensions = ? AND s.id != ?
      ORDER BY s.captured_at DESC, s.id DESC LIMIT ?
    `)
    return callsigns.map(callsign => ({
      callsign,
      embeddings: query.all(callsign, SPEAKER_VERSION, SPEAKER_DIMENSIONS, excludeId, SPEAKER_REFERENCE_LIMIT)
        .map(row => decodeVoiceprint(row.embedding)),
    }))
  }

  private loadVectorExtension(): void {
    if (this.vectorExtensionLoaded)
      return
    this.database.enableLoadExtension(true)
    try {
      sqliteVec.load(this.database)
      this.vectorExtensionLoaded = true
    }
    finally { this.database.enableLoadExtension(false) }
  }

  updateAnalysis(record: RecognitionRecord): boolean {
    const result = this.database.prepare(`
      UPDATE ai_segments
      SET revise = ?, callsign = ?, callsign_algorithm = ?, risk_level = ?, risk_reason = ?
      WHERE id = ?
    `).run(
      record.revise ?? null,
      record.callsign ?? null,
      record.callsign ? record.callsignAlgorithm ?? null : null,
      record.risk?.level ?? null,
      record.risk?.reason ?? null,
      record.id,
    )
    return Number(result.changes) === 1
  }

  updateManualReview(id: string, patch: ManualReviewPatch, allowReviewed: boolean = true): boolean {
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

    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = this.database.prepare(`
        UPDATE ai_segments SET ${assignments.join(', ')} WHERE id = ? ${allowReviewed ? '' : 'AND reviewed = 0'}
      `).run(...values, id)
      if (Number(result.changes) === 1 && (patch.reviewed === true || patch.callsign !== undefined)) {
        const updated = this.find(id)!
        if (updated.reviewed && !hasCallerCallsign(updated)) {
          this.database.exec('ROLLBACK')
          return false
        }
      }
      if (Number(result.changes) === 1 && patch.reviewed === true) {
        this.database.prepare(`
          INSERT INTO ai_segment_embeddings (record_id, version, dimensions, status, embedding)
          SELECT id, ?, ?, 'pending', NULL FROM ai_segments WHERE id = ? AND reviewed = 1
          ON CONFLICT(record_id) DO UPDATE SET version = excluded.version, dimensions = excluded.dimensions,
            status = 'pending', embedding = NULL, reason = NULL
          WHERE ai_segment_embeddings.version != excluded.version OR ai_segment_embeddings.dimensions != excluded.dimensions
            OR ai_segment_embeddings.status != 'ready'
        `).run(SPEAKER_VERSION, SPEAKER_DIMENSIONS, id)
      }
      this.database.exec('COMMIT')
      return Number(result.changes) === 1
    }
    catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
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
        revise, callsign, callsign_algorithm, risk_level, risk_reason, manual_callsign, callee_callsign,
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
    callsignAlgorithm: nullableString(row.callsign_algorithm),
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
