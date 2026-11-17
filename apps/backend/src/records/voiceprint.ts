import type { Voiceprint } from './types.js'

const DIMENSIONS = 256

// Explicit little-endian Float32, independent of the host architecture.
export function encodeVoiceprint(voiceprint: Voiceprint): Uint8Array | null {
  if (voiceprint.status !== 'ready')
    return null
  if (voiceprint.embedding.length !== DIMENSIONS)
    throw new Error('Unexpected voiceprint dimension')
  const bytes = new Uint8Array(DIMENSIONS * 4)
  const view = new DataView(bytes.buffer)
  let norm = 0
  for (let i = 0; i < DIMENSIONS; i++) {
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
