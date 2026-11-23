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
