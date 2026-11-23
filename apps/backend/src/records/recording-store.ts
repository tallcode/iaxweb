import { closeSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

export function recordingPath(directory: string, id: string, capturedAt: string): string {
  const recordedAt = new Date(capturedAt)
  if (Number.isNaN(recordedAt.getTime()))
    throw new Error(`Invalid segment timestamp: ${capturedAt}`)
  if (!validSegmentId(id))
    throw new Error(`Invalid segment id: ${id}`)
  const day = recordedAt.toISOString().slice(0, 10).replaceAll('-', '')
  return join(directory, day, `${id}.wav`)
}

// The date directory is UTC, matching the timestamp stored in SQLite.
export class RecordingStore {
  private readonly rootDirectory: string

  constructor(rootDirectory: string) {
    this.rootDirectory = resolve(rootDirectory)
  }

  async has(id: string, capturedAt: string): Promise<boolean> {
    if (!validSegmentId(id) || !Number.isFinite(Date.parse(capturedAt)))
      return false
    try {
      return (await stat(recordingPath(this.rootDirectory, id, capturedAt))).isFile()
    }
    catch (error) {
      if (missingRecording(error))
        return false
      throw error
    }
  }

  async read(id: string, capturedAt: string): Promise<Uint8Array> {
    return readFile(recordingPath(this.rootDirectory, id, capturedAt))
  }

  remove(id: string, capturedAt: string): void {
    const path = recordingPath(this.rootDirectory, id, capturedAt)
    try {
      unlinkSync(path)
    }
    catch (error) {
      if (!missingRecording(error))
        throw error
    }
  }

  save(id: string, capturedAt: string, wav: Uint8Array): string {
    const path = recordingPath(this.rootDirectory, id, capturedAt)
    mkdirSync(dirname(path), { recursive: true })
    const file = openSync(path, 'wx')
    try {
      try {
        writeFileSync(file, wav)
      }
      finally { closeSync(file) }
    }
    catch (error) {
      try {
        this.remove(id, capturedAt)
      }
      catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Failed to write WAV and remove the incomplete file')
      }
      throw error
    }
    return path
  }
}

function validSegmentId(id: string): boolean {
  return /^[0-9a-f-]+$/i.test(id)
}

function missingRecording(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}
