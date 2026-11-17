import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { backupLegacyEmbeddings } from '../../src/records/embedding-schema.js'

test('unusable backup subdirectory falls back to the database directory with a complete WAL snapshot', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'iaxweb-backup-fallback-'))
  const filename = join(directory, 'ai.sqlite')
  const database = new DatabaseSync(filename)
  t.after(() => {
    database.close()
    rmSync(directory, { recursive: true, force: true })
  })
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE ai_segment_embeddings (record_id TEXT PRIMARY KEY, embedding BLOB);
    INSERT INTO ai_segment_embeddings VALUES ('legacy', zeroblob(1024));
  `)
  // A file at this path also reproduces a directory that cannot be used for
  // backups, without depending on root/Windows permission semantics in CI.
  writeFileSync(join(directory, 'backups'), 'existing file')
  const target = backupLegacyEmbeddings(database, filename)
  assert.ok(target)
  assert.equal(dirname(target), directory)
  const snapshot = new DatabaseSync(target, { readOnly: true })
  try {
    assert.equal(snapshot.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok')
    assert.equal(snapshot.prepare('SELECT length(embedding) AS n FROM ai_segment_embeddings').get()?.n, 1024)
    assert.equal(database.prepare('SELECT length(embedding) AS n FROM ai_segment_embeddings').get()?.n, 1024)
  }
  finally { snapshot.close() }
})

test('backup failure preserves source rows and removes its incomplete output', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'iaxweb-backup-failed-'))
  const filename = join(directory, 'ai.sqlite')
  const database = new DatabaseSync(filename)
  t.after(() => {
    database.close()
    rmSync(directory, { recursive: true, force: true })
  })
  database.exec(`
    CREATE TABLE ai_segment_embeddings (record_id TEXT PRIMARY KEY, embedding BLOB);
    INSERT INTO ai_segment_embeddings VALUES ('legacy', zeroblob(1024));
    BEGIN;
  `)
  assert.throws(() => backupLegacyEmbeddings(database, filename), /未清空旧声纹/)
  assert.equal(database.prepare('SELECT length(embedding) AS n FROM ai_segment_embeddings').get()?.n, 1024)
  assert.deepEqual(readdirSync(join(directory, 'backups')), [])
  database.exec('ROLLBACK')
})
