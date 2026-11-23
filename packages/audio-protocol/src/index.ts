// iaxmon publishes mono G.711 μ-law (PCMU) audio at 8 kHz.
export const SAMPLE_RATE = 8_000

const FRAME_HEADER_BYTES = 10
const FRAME_VERSION = 1
const FRAME_TYPE = 1

// The 10-byte header holds the version, type, and big-endian uint32 media
// timestamp in milliseconds at bytes 6–9. The returned payload views the input.
export function parseAudioFrame(data: Uint8Array): { payload: Uint8Array, timestamp: number } | undefined {
  if (data.byteLength <= FRAME_HEADER_BYTES || data[0] !== FRAME_VERSION || data[1] !== FRAME_TYPE)
    return undefined

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  return { payload: data.subarray(FRAME_HEADER_BYTES), timestamp: view.getUint32(6, false) }
}

// Nearby timestamps remain comparable across the uint32 wrap boundary.
export function signedMediaTimestampDifference(current: number, previous: number): number {
  return (current - previous) | 0
}

/** Decode one G.711 μ-law byte to a signed PCM16 sample. */
export function decodeMuLawSample(encoded: number): number {
  const muLaw = (~encoded) & 0xFF
  const sign = muLaw & 0x80
  const exponent = (muLaw >> 4) & 0x07
  const mantissa = muLaw & 0x0F
  const sample = (((mantissa << 3) + 0x84) << exponent) - 0x84
  return sign ? -sample : sample
}
