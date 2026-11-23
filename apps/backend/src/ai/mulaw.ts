import { decodeMuLawSample } from '@iaxweb/audio-protocol'

export { SAMPLE_RATE } from '@iaxweb/audio-protocol'

// Decodes G.711 μ-law bytes into signed 16-bit PCM.
export function decodeMuLaw(encoded: Uint8Array): Int16Array {
  const samples = new Int16Array(encoded.length)
  for (let index = 0; index < encoded.length; index++)
    samples[index] = decodeMuLawSample(encoded[index] ?? 0)
  return samples
}

// Linear RMS of 16-bit PCM, normalized to 0..1.
export function rmsOfPcm(pcm: Int16Array): number {
  if (pcm.length === 0)
    return 0
  let sumSquares = 0
  for (let index = 0; index < pcm.length; index++) {
    const sample = (pcm[index] ?? 0) / 32_768
    sumSquares += sample * sample
  }
  return Math.sqrt(sumSquares / pcm.length)
}
