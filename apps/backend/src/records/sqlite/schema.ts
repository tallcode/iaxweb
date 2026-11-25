import type { DatabaseSync } from 'node:sqlite'
import { SPEAKER_DIMENSIONS, SPEAKER_VERSION } from '../../ai/speaker-model.mjs'
import { SPEAKER_MAX_AUDIO_MS } from '../../ai/speaker-resources.js'

const EMBEDDING_CONSTRAINT = `speaker_embedding_${SPEAKER_DIMENSIONS}_float32`

// Keep persisted SQL names stable so existing recording history needs no rename migration.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS ai_segments (
    id                TEXT PRIMARY KEY,
    node_id           TEXT NOT NULL,
    source_repeater_id TEXT,
    captured_at       TEXT NOT NULL,
    duration_ms       INTEGER NOT NULL CHECK (duration_ms >= 0),
    voiced_ms         INTEGER NOT NULL CHECK (voiced_ms >= 0),

    recognition       TEXT NOT NULL,
    corrected         TEXT,
    callsign          TEXT COLLATE NOCASE,
    callsign_algorithm TEXT,
    signaling         TEXT,
    audio_quality     TEXT,

    manual_callsign   TEXT COLLATE NOCASE,
    manual_recognition TEXT,
    reviewed          INTEGER NOT NULL DEFAULT 0 CHECK (reviewed IN (0, 1)),
    callee_callsign   TEXT COLLATE NOCASE,
    manual_note       TEXT,

    created_at        TEXT NOT NULL
                      DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE VIEW IF NOT EXISTS ai_segments_effective AS
  SELECT
    *,
    COALESCE(manual_callsign, callsign) AS effective_callsign
  FROM ai_segments;
`

const INDEXES = `
  CREATE INDEX IF NOT EXISTS ai_segments_capture_order
    ON ai_segments (captured_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS ai_segments_effective_callsign_order
    ON ai_segments (COALESCE(manual_callsign, callsign) COLLATE NOCASE, captured_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS ai_segments_edited_order
    ON ai_segments (captured_at DESC, id DESC)
    WHERE manual_recognition IS NOT NULL OR manual_callsign IS NOT NULL OR callee_callsign IS NOT NULL;
  CREATE INDEX IF NOT EXISTS ai_segments_reviewed_order
    ON ai_segments (captured_at DESC, id DESC) WHERE reviewed = 1;
`

export function initializeRecordSchema(database: DatabaseSync): void {
  database.exec(SCHEMA)
  const columns = new Set(database.prepare('PRAGMA table_info(ai_segments)').all().map(row => row.name))
  if (!columns.has('manual_recognition'))
    database.exec('ALTER TABLE ai_segments ADD COLUMN manual_recognition TEXT')
  if (!columns.has('reviewed'))
    database.exec('ALTER TABLE ai_segments ADD COLUMN reviewed INTEGER NOT NULL DEFAULT 0 CHECK (reviewed IN (0, 1))')
  if (!columns.has('callsign_algorithm'))
    database.exec('ALTER TABLE ai_segments ADD COLUMN callsign_algorithm TEXT')
  if (!columns.has('signaling'))
    database.exec('ALTER TABLE ai_segments ADD COLUMN signaling TEXT')
  if (!columns.has('source_repeater_id'))
    database.exec('ALTER TABLE ai_segments ADD COLUMN source_repeater_id TEXT')
  database.exec(INDEXES)
  database.exec(`
    CREATE TABLE IF NOT EXISTS ai_segment_embeddings (
      record_id TEXT PRIMARY KEY REFERENCES ai_segments(id) ON DELETE CASCADE,
      version TEXT NOT NULL,
      dimensions INTEGER NOT NULL DEFAULT ${SPEAKER_DIMENSIONS} CHECK (dimensions = ${SPEAKER_DIMENSIONS}),
      status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'unavailable', 'failed')),
      embedding BLOB,
      reason TEXT,
      CONSTRAINT ${EMBEDDING_CONSTRAINT} CHECK (
        (status = 'ready' AND embedding IS NOT NULL AND typeof(embedding) = 'blob'
          AND length(embedding) = ${SPEAKER_DIMENSIONS * 4})
        OR (status != 'ready' AND embedding IS NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS ai_segment_embeddings_ready_version
      ON ai_segment_embeddings (version, record_id) WHERE status = 'ready';
    CREATE INDEX IF NOT EXISTS ai_segment_embeddings_pending
      ON ai_segment_embeddings (record_id) WHERE status = 'pending';
  `)
  // Retry only the old 20s/640MiB policy rejections. New-policy reasons are
  // distinct so restarts cannot repeatedly retry the same unavailable audio.
  database.prepare(`
    UPDATE ai_segment_embeddings SET status = 'pending', reason = NULL
    WHERE version = ? AND status = 'unavailable'
      AND reason IN ('audio_too_long', 'resource_limit')
      AND record_id IN (SELECT id FROM ai_segments WHERE reviewed = 1 AND duration_ms <= ?)
  `).run(SPEAKER_VERSION, SPEAKER_MAX_AUDIO_MS)
}
