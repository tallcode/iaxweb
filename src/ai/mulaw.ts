// iaxmon publishes node audio as G.711 μ-law (PCMU), 8 kHz mono.
export const SAMPLE_RATE = 8_000

// Decodes G.711 μ-law bytes into signed 16-bit PCM, mirroring the browser
// decoder in public/audio-player.js.
export function decodeMuLaw(encoded: Uint8Array): Int16Array {
  const samples = new Int16Array(encoded.length)
  for (let index = 0; index < encoded.length; index++) {
    const muLaw = (~(encoded[index] ?? 0)) & 0xFF
    const sign = muLaw & 0x80
    const exponent = (muLaw >> 4) & 0x07
    const mantissa = muLaw & 0x0F
    let sample = ((mantissa << 3) + 0x84) << exponent
    sample -= 0x84
    samples[index] = sign ? -sample : sample
  }
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
