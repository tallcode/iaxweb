import { SAMPLE_RATE } from './mulaw.js'

// Builds a minimal RIFF/WAVE file (16-bit PCM mono) for the DashScope ASR API.
export function encodeWav(pcm: Int16Array, sampleRate: number = SAMPLE_RATE): Uint8Array {
  const dataSize = pcm.length * 2
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(view, 8, 'WAVE')
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate (16-bit mono)
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeString(view, 36, 'data')
  view.setUint32(40, dataSize, true)

  const bytes = new Uint8Array(buffer)
  bytes.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 44)
  return bytes
}

function writeString(view: DataView, offset: number, text: string): void {
  for (let index = 0; index < text.length; index++)
    view.setUint8(offset + index, text.charCodeAt(index))
}
