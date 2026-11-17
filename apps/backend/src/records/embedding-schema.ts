import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { SPEAKER_DIMENSIONS } from '../ai/speaker-model.mjs'

const EMBEDDING_CONSTRAINT = `speaker_embedding_${SPEAKER_DIMENSIONS}_float32`

function hasCurrentSchema(database: DatabaseSync): boolean {
  const row = database.prepare('SELECT sql FROM sqlite_master WHERE type = \'table\' AND name = \'ai_segment_embeddings\'').get()
  return typeof row?.sql === 'string' && row.sql.includes(`CONSTRAINT ${EMBEDDING_CONSTRAINT}`)
}

function columns(database: DatabaseSync): Set<string> {
  return new Set(database.prepare('PRAGMA table_info(ai_segment_embeddings)').all().map(row => String(row.name)))
}

// VACUUM INTO takes a consistent SQLite snapshot, including WAL contents.
// Call before the migration transaction; never copy a live database file.
export function backupLegacyEmbeddings(database: DatabaseSync, databaseFile: string): string | undefined {
  const existing = columns(database)
  if (databaseFile === ':memory:' || existing.size === 0 || hasCurrentSchema(database))
    return undefined
  const directory = join(dirname(databaseFile), 'backups')
  mkdirSync(directory, { recursive: true })
  const filename = join(directory, `speaker-upgrade-${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.sqlite`)
  database.prepare('VACUUM main INTO ?').run(filename)
  return filename
}

function schema(): string {
  return `
    CREATE TABLE ai_segment_embeddings (
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
  `
}

// Caller owns the transaction. Reset the legacy embedding cache once, leaving
// recordings, recognition results and reviews intact. Reviewed rows are rebuilt
// by the durable background queue; reopening the current schema keeps its data.
export function migrateEmbeddingSchema(database: DatabaseSync): void {
  const existing = columns(database)
  if (existing.size === 0) {
    database.exec(schema())
  }
  else if (!hasCurrentSchema(database)) {
    database.exec('DROP TABLE ai_segment_embeddings')
    database.exec(schema())
  }
  else if (!existing.has('reason')) {
    database.exec('ALTER TABLE ai_segment_embeddings ADD COLUMN reason TEXT')
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS ai_segment_embeddings_ready_version
      ON ai_segment_embeddings (version, record_id) WHERE status = 'ready';
    CREATE INDEX IF NOT EXISTS ai_segment_embeddings_pending
      ON ai_segment_embeddings (record_id) WHERE status = 'pending';
  `)
}
