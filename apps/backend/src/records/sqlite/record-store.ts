import type { PersistedRecord, RadioSignal } from '@iaxweb/contracts'
import type { DatabaseSync } from 'node:sqlite'
import type { ManualReviewPatch, RecognitionRecord, RecordPage } from '../types.js'
import type { SqliteSpeakerStore } from './speaker-store.js'
import { hasCallerCallsign, radioSignalsSchema } from '@iaxweb/contracts'
import { parseAudioQuality } from '../audio-quality.js'
import { nullableString, requiredNumber, requiredString } from './row-values.js'

const SELECT_EFFECTIVE = `
  SELECT
    id,
    node_id,
    captured_at,
    duration_ms,
    voiced_ms,
    recognition,
    corrected,
    callsign,
    callsign_algorithm,
    signaling,
    audio_quality,
    manual_callsign,
    manual_recognition,
    reviewed,
    callee_callsign,
    manual_note,
    created_at,
    effective_callsign
`

// Manual fields override stored recognition evidence through the effective view.
export class SqliteRecordStore {
  constructor(
    private readonly database: DatabaseSync,
    private readonly speakers: Pick<SqliteSpeakerStore, 'prepareReviewedVoiceprint'>,
  ) {}

  insert(nodeId: string, record: RecognitionRecord): void {
    if (record.recognition === undefined)
      throw new Error('Cannot persist a segment without recognition text')

    this.database.prepare(`
      INSERT INTO ai_segments (
        id, node_id, captured_at, duration_ms, voiced_ms, recognition, corrected, audio_quality
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      nodeId,
      record.timestamp,
      record.durationMs,
      record.voicedMs,
      record.recognition,
      record.corrected ?? null,
      record.audioQuality ? JSON.stringify(record.audioQuality) : null,
    )
  }

  updateSignaling(id: string, signals: readonly RadioSignal[]): boolean {
    const validated = radioSignalsSchema.parse(signals)
    return Number(this.database.prepare('UPDATE ai_segments SET signaling = ? WHERE id = ?')
      .run(JSON.stringify(validated), id).changes) === 1
  }

  updateAutomaticCallsign(record: RecognitionRecord): boolean {
    const result = this.database.prepare(`
      UPDATE ai_segments
      SET callsign = ?, callsign_algorithm = ?
      WHERE id = ?
    `).run(
      record.callsign ?? null,
      record.callsign ? record.callsignAlgorithm ?? null : null,
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
    if (patch.note !== undefined) {
      assignments.push('manual_note = ?')
      values.push(patch.note)
    }
    if (assignments.length === 0)
      throw new Error('Manual review patch must contain at least one field')

    this.database.exec('BEGIN IMMEDIATE')
    try {
      const changed = Number(this.database.prepare(`
        UPDATE ai_segments SET ${assignments.join(', ')} WHERE id = ? ${allowReviewed ? '' : 'AND reviewed = 0'}
      `).run(...values, id).changes) === 1
      if (changed && (patch.reviewed === true || patch.callsign !== undefined)) {
        const updated = this.find(id)!
        if (updated.reviewed && !hasCallerCallsign(updated)) {
          this.database.exec('ROLLBACK')
          return false
        }
      }
      if (changed && patch.reviewed === true)
        this.speakers.prepareReviewedVoiceprint(id, true)
      this.database.exec('COMMIT')
      return changed
    }
    catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  find(id: string): PersistedRecord | undefined {
    const row = this.database.prepare(`${SELECT_EFFECTIVE} FROM ai_segments_effective WHERE id = ?`).get(id)
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
    if (callsign?.startsWith('%')) {
      const suffix = callsign.slice(1)
      conditions.push('substr(effective_callsign, -length(?)) = ? COLLATE NOCASE')
      parameters.push(suffix, suffix)
    }
    else if (callsign !== undefined) {
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
      ${SELECT_EFFECTIVE}
      FROM ai_segments_effective
      ${whereClause}
      ORDER BY captured_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(...parameters, pageSize, (page - 1) * pageSize)
    return { items: rows.map(mapRow), page, pageSize, total }
  }
}

function mapRow(row: Record<string, unknown>): PersistedRecord {
  return {
    calleeCallsign: nullableString(row.callee_callsign),
    callsign: nullableString(row.callsign),
    callsignAlgorithm: nullableString(row.callsign_algorithm),
    signaling: parseSignaling(row.signaling),
    audioQuality: parseAudioQuality(row.audio_quality),
    capturedAt: requiredString(row.captured_at),
    corrected: nullableString(row.corrected),
    createdAt: requiredString(row.created_at),
    durationMs: requiredNumber(row.duration_ms),
    effectiveCallsign: nullableString(row.effective_callsign),
    id: requiredString(row.id),
    manualCallsign: nullableString(row.manual_callsign),
    manualRecognition: nullableString(row.manual_recognition),
    manualNote: nullableString(row.manual_note),
    nodeId: requiredString(row.node_id),
    recognition: requiredString(row.recognition),
    reviewed: requiredNumber(row.reviewed) === 1,
    voicedMs: requiredNumber(row.voiced_ms),
  }
}

function parseSignaling(value: unknown): readonly RadioSignal[] | null {
  if (typeof value !== 'string')
    return null
  try {
    const parsed = radioSignalsSchema.safeParse(JSON.parse(value))
    return parsed.success ? parsed.data : null
  }
  catch { return null }
}
