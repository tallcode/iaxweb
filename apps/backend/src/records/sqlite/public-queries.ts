import type { DatabaseSync } from 'node:sqlite'
import type { PublicRecordQueries } from '../ports.js'
import type { SpeechHour, StoredSpot } from '../types.js'
import { requiredNumber, requiredString } from './row-values.js'

export class SqlitePublicRecordQueries implements PublicRecordQueries {
  constructor(private readonly database: DatabaseSync) {}

  speechHours(startAt: string, endAt: string): SpeechHour[] {
    return this.database.prepare(`
      SELECT
        strftime('%Y-%m-%d', captured_at, '+8 hours') AS date,
        CAST(strftime('%H', captured_at, '+8 hours') AS INTEGER) AS hour,
        COUNT(*) AS count,
        SUM(voiced_ms) AS voiced_ms
      FROM ai_segments
      WHERE captured_at >= ? AND captured_at < ?
      GROUP BY date, hour
    `).all(startAt, endAt).map(row => ({
      count: requiredNumber(row.count),
      date: requiredString(row.date),
      hour: requiredNumber(row.hour),
      voicedMs: requiredNumber(row.voiced_ms),
    }))
  }

  recentSpots(limit: number = 30): StoredSpot[] {
    if (!Number.isInteger(limit) || limit < 1)
      throw new Error('Spot limit must be a positive integer')
    const rows = this.database.prepare(`
      WITH ranked AS (
        SELECT
          id,
          node_id,
          captured_at,
          effective_callsign,
          ROW_NUMBER() OVER (
            PARTITION BY effective_callsign
            ORDER BY captured_at DESC, id DESC
          ) AS row_number
        FROM ai_segments_effective
        WHERE effective_callsign IS NOT NULL
          AND effective_callsign <> 'N0CALL'
      )
      SELECT id, node_id, captured_at, effective_callsign
      FROM ranked
      WHERE row_number = 1
      ORDER BY captured_at DESC, id DESC
      LIMIT ?
    `).all(limit)
    return rows.map(row => ({
      at: requiredString(row.captured_at),
      callsign: requiredString(row.effective_callsign),
      id: requiredString(row.id),
      node: requiredString(row.node_id),
    }))
  }
}
