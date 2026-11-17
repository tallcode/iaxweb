import { open } from 'node:fs/promises'
import { join } from 'node:path'

export function speakerWavFile(directory: string, record: { id: string, timestamp: string }): string {
  if (!/^[0-9a-f-]+$/i.test(record.id) || !Number.isFinite(Date.parse(record.timestamp)))
    throw new Error('Invalid record ID or timestamp')
  const date = new Date(record.timestamp).toISOString().slice(0, 10).replaceAll('-', '')
  return join(directory, date, `${record.id}.wav`)
}

// Stored recordings are PCM16 mono 8kHz. Parse RIFF chunks rather than assuming
// a 44-byte header, and bound memory before reading a historical file.
export async function readSpeakerWav(filename: string, signal?: AbortSignal): Promise<Float32Array> {
  const handle = await open(filename, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > 10 * 1024 * 1024)
      throw new Error('Invalid or oversized WAV file')
    const bytes = await handle.readFile(signal ? { signal } : {})
    if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE')
      throw new Error('Invalid RIFF/WAVE header')
    const end = bytes.readUInt32LE(4) + 8
    if (end > bytes.length || end < 12)
      throw new Error('Truncated RIFF/WAVE file')
    let formatValid = false
    let data: Uint8Array | undefined
    for (let offset = 12; offset + 8 <= end;) {
      const kind = bytes.toString('ascii', offset, offset + 4)
      const length = bytes.readUInt32LE(offset + 4)
      const start = offset + 8
      if (start + length > end)
        throw new Error('Truncated WAV chunk')
      if (kind === 'fmt ') {
        if (length < 16)
          throw new Error('Invalid WAV format chunk')
        formatValid = bytes.readUInt16LE(start) === 1
          && bytes.readUInt16LE(start + 2) === 1
          && bytes.readUInt32LE(start + 4) === 8_000
          && bytes.readUInt16LE(start + 12) === 2
          && bytes.readUInt16LE(start + 14) === 16
      }
      if (kind === 'data') {
        if (data)
          throw new Error('Multiple WAV data chunks are unsupported')
        data = bytes.subarray(start, start + length)
      }
      offset = start + length + (length % 2)
    }
    if (!formatValid || !data || data.length % 2 !== 0 || data.length > 8_000 * 2 * 300)
      throw new Error('Expected PCM16 mono 8kHz WAV, at most 300 seconds')
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    return Float32Array.from({ length: data.length / 2 }, (_, i) => view.getInt16(i * 2, true) / 32_768)
  }
  finally {
    await handle.close()
  }
}
