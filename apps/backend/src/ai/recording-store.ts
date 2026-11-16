import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const DATE_CACHE_MS = 12 * 60 * 60 * 1_000
const DATE_DIRECTORY = /^\d{4}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/
interface DateCache {
  dates: Set<string>
  expiresAt: number
  scanning?: Promise<string[]>
}
const dateCaches = new Map<string, DateCache>()

// Stores one WAV per successfully recognized segment. The date directory is
// UTC so an ISO timestamp and its on-disk path always sort consistently.
export class RecordingStore {
  private readonly rootDirectory: string

  constructor(rootDirectory: string) {
    this.rootDirectory = resolve(rootDirectory)
  }

  async availableDates(): Promise<string[]> {
    const cached = dateCaches.get(this.rootDirectory)
    if (cached?.scanning)
      return cached.scanning
    if (cached && Date.now() < cached.expiresAt)
      return [...cached.dates].sort()

    const cache: DateCache = { dates: new Set(), expiresAt: 0 }
    dateCaches.set(this.rootDirectory, cache)
    cache.scanning = this.scanDates().then((dates) => {
      for (const date of dates)
        cache.dates.add(date)
      cache.expiresAt = Date.now() + DATE_CACHE_MS
      return [...cache.dates].sort()
    }).catch((error: unknown) => {
      dateCaches.delete(this.rootDirectory)
      throw error
    }).finally(() => {
      delete cache.scanning
    })
    return cache.scanning
  }

  private async scanDates(): Promise<string[]> {
    try {
      const entries = await readdir(this.rootDirectory, { withFileTypes: true })
      return entries.filter(entry => entry.isDirectory() && DATE_DIRECTORY.test(entry.name)).map(entry => entry.name)
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return []
      throw error
    }
  }

  remove(segmentId: string, capturedAt: string): void {
    const recordedAt = new Date(capturedAt)
    if (Number.isNaN(recordedAt.getTime()))
      throw new Error(`Invalid segment timestamp: ${capturedAt}`)
    if (!/^[0-9a-f-]+$/i.test(segmentId))
      throw new Error(`Invalid segment id: ${segmentId}`)
    const date = recordedAt.toISOString().slice(0, 10).replaceAll('-', '')
    try {
      unlinkSync(join(this.rootDirectory, date, `${segmentId}.wav`))
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw error
    }
  }

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
    dateCaches.get(this.rootDirectory)?.dates.add(date)
    return path
  }
}
