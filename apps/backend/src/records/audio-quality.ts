import type { AudioQuality } from '@iaxweb/contracts'
import type { DatabaseSync } from 'node:sqlite'
import type { Voiceprint } from './types.js'
import { audioQualitySchema } from '@iaxweb/contracts'

export const QUALITY_REASONS = ['interference_high_band', 'interference_tone', 'invalid_audio'] as const

export function isQualityReason(reason: string | undefined): boolean {
  return (QUALITY_REASONS as readonly string[]).includes(reason ?? '')
}

export function parseAudioQuality(value: unknown): AudioQuality | null {
  if (typeof value !== 'string')
    return null
  try {
    const result = audioQualitySchema.safeParse(JSON.parse(value))
    return result.success ? result.data : null
  }
  catch { return null }
}

export function storeAudioQuality(database: DatabaseSync, id: string, quality: AudioQuality, onlyMissing = false): boolean {
  const validated = audioQualitySchema.parse(quality)
  return Number(database.prepare(`
    UPDATE ai_segments SET audio_quality = ? WHERE id = ?
      ${onlyMissing ? 'AND audio_quality IS NULL' : ''}
  `).run(JSON.stringify(validated), id).changes) === 1
}

// Compatibility for older extraction callers: quality reasons belong to the
// recording. Real pipeline checks save their full metrics before extraction.
export function voiceprintQuality(voiceprint: Voiceprint): AudioQuality | undefined {
  if (isQualityReason(voiceprint.reason))
    return { status: 'rejected', reason: voiceprint.reason!, metrics: null }
  if (voiceprint.status === 'ready')
    return { status: 'passed', reason: null, metrics: null }
  return undefined
}

// Caller owns the transaction. Only adding the column marks existing records
// as historical skip. Reopening must never reset a newly checked quality.
export function migrateAudioQuality(database: DatabaseSync): void {
  const columns = database.prepare('PRAGMA table_info(ai_segments)').all()
  if (!columns.some(row => row.name === 'audio_quality')) {
    database.exec('ALTER TABLE ai_segments ADD COLUMN audio_quality TEXT')
    database.prepare('UPDATE ai_segments SET audio_quality = ?')
      .run(JSON.stringify({ status: 'skip', reason: null, metrics: null }))
    const embeddings = database.prepare('PRAGMA table_info(ai_segment_embeddings)').all()
    if (embeddings.some(row => row.name === 'reason')) {
      // Retain the old diagnostic without claiming a new quality assessment.
      database.exec(`
        UPDATE ai_segments SET audio_quality = json_object('status', 'skip', 'reason',
          (SELECT reason FROM ai_segment_embeddings WHERE record_id = ai_segments.id), 'metrics', NULL)
        WHERE id IN (SELECT record_id FROM ai_segment_embeddings
          WHERE reason IN ('interference_high_band', 'interference_tone', 'invalid_audio'));
        UPDATE ai_segment_embeddings SET reason = NULL
          WHERE reason IN ('interference_high_band', 'interference_tone', 'invalid_audio');
      `)
    }
  }
}
