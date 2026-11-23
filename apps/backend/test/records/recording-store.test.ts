import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { saveRecognizedRecording } from '../../src/records/recognition-persistence.js'
import { RecordingStore } from '../../src/records/recording-store.js'

test('writes each recording beneath its UTC date directory', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'iaxweb-rec-'))
  t.after(() => rmSync(root, { force: true, recursive: true }))
  const store = new RecordingStore(root)
  const wav = Uint8Array.from([82, 73, 70, 70])

  const path = store.save('a1b2c3d4-e5f6-7890-abcd-ef0123456789', '2026-08-12T00:30:00.000Z', wav)
  assert.equal(path, join(root, '20260812', 'a1b2c3d4-e5f6-7890-abcd-ef0123456789.wav'))
  assert.equal(existsSync(path), true)
  assert.deepEqual(new Uint8Array(readFileSync(path)), wav)
})

test('refuses invalid identifiers and overwriting an existing recording', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'iaxweb-rec-'))
  t.after(() => rmSync(root, { force: true, recursive: true }))
  const store = new RecordingStore(root)
  const id = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789'
  store.save(id, '2026-08-12T00:30:00.000Z', new Uint8Array())

  assert.throws(() => store.save(id, '2026-08-12T00:30:00.000Z', new Uint8Array()), /EEXIST/)
  assert.throws(() => store.save('../bad', '2026-08-12T00:30:00.000Z', new Uint8Array()), /Invalid segment id/)
})

test('removes only the selected WAV and tolerates an already missing recording', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'iaxweb-rec-remove-'))
  t.after(() => rmSync(root, { force: true, recursive: true }))
  const store = new RecordingStore(root)
  const id = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789'
  const other = 'b1b2c3d4-e5f6-7890-abcd-ef0123456789'
  const at = '2026-08-12T23:30:00.000Z'
  const path = store.save(id, at, new Uint8Array())
  const otherPath = store.save(other, at, new Uint8Array())
  store.remove(id, at)
  assert.equal(existsSync(path), false)
  assert.equal(existsSync(otherPath), true)
  assert.doesNotThrow(() => store.remove(id, at))
  assert.throws(() => store.remove('../bad', at), /Invalid segment id/)
  assert.throws(() => store.remove(other, 'invalid date'), /Invalid segment timestamp/)
  assert.equal(existsSync(otherPath), true)
})

test('reports audio availability per recording and observes deletions immediately', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'iaxweb-rec-availability-'))
  t.after(() => rmSync(root, { force: true, recursive: true }))
  const store = new RecordingStore(root)
  const at = '2026-08-12T23:30:00.000Z'
  const bytes = new Uint8Array([82, 73, 70, 70])
  assert.equal(await store.has('aabbcc', at), false)
  store.save('aabbcc', at, bytes)
  assert.equal(await store.has('aabbcc', at), true)
  assert.deepEqual(new Uint8Array(await store.read('aabbcc', at)), bytes)
  assert.equal(await store.has('bbccdd', at), false)
  store.remove('aabbcc', at)
  mkdirSync(join(root, '20260812', 'aabbcc.wav'))
  assert.equal(await store.has('aabbcc', at), false)
})

test('removes the new WAV when the database insert fails', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'iaxweb-rec-rollback-'))
  t.after(() => rmSync(root, { force: true, recursive: true }))
  const store = new RecordingStore(root)
  const record = {
    id: 'aabbcc',
    timestamp: '2026-08-12T23:30:00.000Z',
    recognition: 'test',
    durationMs: 1000,
    voicedMs: 900,
  }
  const repository = {
    insert() {
      throw new Error('SQLite unavailable')
    },
  }
  assert.throws(() => saveRecognizedRecording(repository, store, '1900', record, new Uint8Array()), /SQLite unavailable/)
  assert.equal(await store.has(record.id, record.timestamp), false)
})
