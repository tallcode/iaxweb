import type { PublicStats, StatsDay } from '@iaxweb/contracts'
import type { RecordRepository } from './record-repository.js'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { publicStatsSchema } from '@iaxweb/contracts'
import { z } from 'zod'

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
const BEIJING_OFFSET_MS = 8 * HOUR_MS
const HISTORY_DAYS = 30

const snapshotSchema = publicStatsSchema.omit({ stale: true }).extend({ version: z.literal(1) })
type Snapshot = z.output<typeof snapshotSchema>

export class StatsCache {
  private snapshot: Snapshot | undefined
  private pending: Promise<PublicStats> | undefined

  constructor(
    private readonly file: string,
    private readonly repository: Pick<RecordRepository, 'speechHours'>,
    private readonly reportError: (error: unknown) => void,
  ) {}

  get(now = new Date()): Promise<PublicStats> {
    this.pending ??= this.refresh(now).finally(() => {
      this.pending = undefined
    })
    return this.pending
  }

  private async refresh(now: Date): Promise<PublicStats> {
    const previous = this.snapshot ??= await this.read()
    const updatedAt = now.toISOString()
    const midnight = Math.floor((now.getTime() + BEIJING_OFFSET_MS) / DAY_MS) * DAY_MS - BEIJING_OFFSET_MS
    const date = beijingDate(midnight)
    try {
      const history = previous?.today.day.date === date
        ? previous.history
        : { days: this.readDays(midnight - HISTORY_DAYS * DAY_MS, midnight, HISTORY_DAYS), updatedAt }
      const today = previous?.today.updatedAt.slice(0, 13) === updatedAt.slice(0, 13)
        ? previous.today
        : { day: this.readDays(midnight, now.getTime(), 1)[0]!, updatedAt }
      if (history !== previous?.history || today !== previous?.today) {
        const next: Snapshot = { history, today, version: 1 }
        await this.write(next)
        this.snapshot = next
      }
      return { history, today, stale: false }
    }
    catch (error) {
      this.reportError(error)
      if (!previous)
        throw error
      return { history: previous.history, today: previous.today, stale: true }
    }
  }

  private readDays(start: number, end: number, length: number): StatsDay[] {
    const days = Array.from({ length }, (_, index): StatsDay => ({
      date: beijingDate(start + index * DAY_MS),
      hourlyCounts: Array.from<number>({ length: 24 }).fill(0),
      voicedMs: 0,
    }))
    const daysByDate = new Map(days.map(day => [day.date, day]))
    for (const { count, date, hour, voicedMs } of this.repository.speechHours(new Date(start).toISOString(), new Date(end).toISOString())) {
      const day = daysByDate.get(date)
      if (day) {
        day.hourlyCounts[hour] = count
        day.voicedMs += voicedMs
      }
    }
    return days
  }

  private async read(): Promise<Snapshot | undefined> {
    try {
      const parsed = snapshotSchema.safeParse(JSON.parse(await readFile(this.file, 'utf8')))
      return parsed.data
    }
    catch (error) {
      if (!(error instanceof SyntaxError) && !(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
        this.reportError(error)
      return undefined
    }
  }

  private async write(snapshot: Snapshot): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(snapshot)}\n`)
      await rename(temporary, this.file)
    }
    catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }
}

function beijingDate(millis: number): string {
  return new Date(millis + BEIJING_OFFSET_MS).toISOString().slice(0, 10)
}
