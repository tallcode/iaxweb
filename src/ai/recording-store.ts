import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Stores one WAV per successfully recognized segment. The date directory is
// UTC so an ISO timestamp and its on-disk path always sort consistently.
export class RecordingStore {
  constructor(private readonly rootDirectory: string) {}

  save(segmentId: string, capturedAt: string, wav: Uint8Array): string {
    const recordedAt = new Date(capturedAt)
    if (Number.isNaN(recordedAt.getTime()))
      throw new Error(`Invalid segment timestamp: ${capturedAt}`)
    if (!/^[0-9a-f-]+$/i.test(segmentId))
      throw new Error(`Invalid segment id: ${segmentId}`)

    const date = recordedAt.toISOString().slice(0, 10).replaceAll('-', '')
    const directory = join(this.rootDirectory, date)
    const path = join(directory, `${segmentId}.wav`)
    mkdirSync(directory, { recursive: true })
    writeFileSync(path, wav, { flag: 'wx' })
    return path
  }
}
