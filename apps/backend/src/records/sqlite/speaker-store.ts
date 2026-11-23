import type { AudioQuality } from '@iaxweb/contracts'
import type { DatabaseSync } from 'node:sqlite'
import type { PendingReviewedVoiceprint, ReadyVoiceprint, SpeakerReferenceGroup, SpeakerSearchResult, Voiceprint } from '../types.js'
import { CALLSIGN_PREFIX_SOURCE } from '@iaxweb/contracts'
import * as sqliteVec from 'sqlite-vec'
import { SPEAKER_DIMENSIONS, SPEAKER_VERSION } from '../../ai/speaker-model.mjs'
import { SPEAKER_REFERENCE_LIMIT, SPEAKER_REFERENCE_THRESHOLD } from '../../ai/speaker-reference-score.mjs'
import { isQualityReason, storeAudioQuality, voiceprintQuality } from '../audio-quality.js'
import { decodeVoiceprint, encodeVoiceprint } from '../voiceprint.js'
import { requiredNumber, requiredString } from './row-values.js'

const TWO_LETTER_CALLSIGN_GLOB = `${CALLSIGN_PREFIX_SOURCE}[0-9][A-Z][A-Z]`
const THREE_LETTER_CALLSIGN_GLOB = `${TWO_LETTER_CALLSIGN_GLOB}[A-Z]`

export class SqliteSpeakerStore {
  private vectorExtensionLoaded = false

  constructor(private readonly database: DatabaseSync) {}

  updateVoiceprint(id: string, voiceprint: Voiceprint): boolean {
    const changed = Number(this.database.prepare(`
      UPDATE ai_segment_embeddings SET status = ?, embedding = ?, reason = ?
      WHERE record_id = ? AND version = ? AND status = 'pending'
        AND EXISTS (SELECT 1 FROM ai_segments WHERE id = ? AND reviewed = 1)
    `).run(voiceprint.status, encodeVoiceprint(voiceprint), isQualityReason(voiceprint.reason) ? null : voiceprint.reason ?? null, id, voiceprint.version, id).changes) === 1
    const quality = voiceprintQuality(voiceprint)
    if (changed && quality)
      storeAudioQuality(this.database, id, quality, voiceprint.status === 'ready')
    return changed
  }

  updateAudioQuality(id: string, quality: AudioQuality): boolean {
    return storeAudioQuality(this.database, id, quality)
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
    storeAudioQuality(this.database, id, { status: 'passed', reason: null, metrics: null }, true)
  }

  pendingReviewedVoiceprints(limit: number = 10): PendingReviewedVoiceprint[] {
    const rows = this.database.prepare(`
      SELECT s.id, s.captured_at, s.voiced_ms FROM ai_segments s
      LEFT JOIN ai_segment_embeddings e ON e.record_id = s.id
      WHERE s.reviewed = 1 AND (e.record_id IS NULL OR e.version != ? OR e.dimensions != ? OR e.status = 'pending')
        AND (s.audio_quality IS NULL OR CASE WHEN json_valid(s.audio_quality) THEN json_extract(s.audio_quality, '$.status') END = 'passed')
      ORDER BY s.captured_at, s.id LIMIT ?
    `).all(SPEAKER_VERSION, SPEAKER_DIMENSIONS, limit)
    return rows.map(row => ({ id: requiredString(row.id), timestamp: requiredString(row.captured_at), voicedMs: requiredNumber(row.voiced_ms) }))
  }

  prepareReviewedVoiceprint(id: string, retryUnsuccessful = false): boolean {
    return Number(this.database.prepare(`
      INSERT INTO ai_segment_embeddings (record_id, version, dimensions, status, embedding)
      SELECT id, ?, ?, 'pending', NULL FROM ai_segments WHERE id = ? AND reviewed = 1
      ON CONFLICT(record_id) DO UPDATE SET version = excluded.version, dimensions = excluded.dimensions,
        status = 'pending', embedding = NULL, reason = NULL
      WHERE ai_segment_embeddings.version != excluded.version OR ai_segment_embeddings.dimensions != excluded.dimensions
        OR ai_segment_embeddings.status = 'pending'
        OR (? = 1 AND ai_segment_embeddings.status IN ('failed', 'unavailable'))
    `).run(SPEAKER_VERSION, SPEAKER_DIMENSIONS, id, retryUnsuccessful ? 1 : 0).changes) === 1
  }

  searchSpeakerMatches(voiceprint: Voiceprint, excludeId: string): SpeakerSearchResult {
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
          AND (s.audio_quality IS NULL OR CASE WHEN json_valid(s.audio_quality) THEN json_extract(s.audio_quality, '$.status') END IN ('passed', 'skip'))
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
        AND (s.audio_quality IS NULL OR CASE WHEN json_valid(s.audio_quality) THEN json_extract(s.audio_quality, '$.status') END IN ('passed', 'skip'))
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
}
