import type { Voiceprint } from './types.js'
import { SPEAKER_DIMENSIONS } from '../ai/speaker-model.mjs'

// Explicit little-endian Float32, independent of the host architecture.
export function encodeVoiceprint(voiceprint: Voiceprint): Uint8Array | null {
  if (voiceprint.status !== 'ready')
    return null
  if (voiceprint.embedding.length !== SPEAKER_DIMENSIONS)
    throw new Error('Unexpected voiceprint dimension')
  const bytes = new Uint8Array(SPEAKER_DIMENSIONS * 4)
  const view = new DataView(bytes.buffer)
  let norm = 0
  for (let i = 0; i < SPEAKER_DIMENSIONS; i++) {
    const value = voiceprint.embedding[i]!
    if (!Number.isFinite(value))
      throw new Error('Non-finite voiceprint value')
    norm += value * value
    view.setFloat32(i * 4, value, true)
  }
  if (!(norm > 0))
    throw new Error('Empty voiceprint')
  return bytes
}
