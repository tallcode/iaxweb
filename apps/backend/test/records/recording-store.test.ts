import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
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

test('caches date directories for twelve hours and shares newly saved dates across instances', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'iaxweb-rec-dates-'))
  t.after(() => rmSync(root, { force: true, recursive: true }))
  const now = Date.now()
  const clock = t.mock.method(Date, 'now', () => now)
  mkdirSync(join(root, '20260812'))
  mkdirSync(join(root, '20260813'))
  mkdirSync(join(root, 'notes'))
  writeFileSync(join(root, '20260814'), 'A file is not a recording directory')
  const reader = new RecordingStore(root)
  const writer = new RecordingStore(root)

  assert.deepEqual(await reader.availableDates(), ['20260812', '20260813'])
  rmSync(join(root, '20260812'), { recursive: true })
  assert.deepEqual(await writer.availableDates(), ['20260812', '20260813'])
  writer.save('a1b2c3d4-e5f6-7890-abcd-ef0123456789', '2026-08-15T00:30:00.000Z', new Uint8Array())
  assert.deepEqual(await reader.availableDates(), ['20260812', '20260813', '20260815'])

  clock.mock.mockImplementation(() => now + 12 * 60 * 60 * 1_000)
  assert.deepEqual(await reader.availableDates(), ['20260813', '20260815'])
})

test('handles an absent recording root and makes the first saved date available immediately', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'iaxweb-rec-missing-'))
  t.after(() => rmSync(root, { force: true, recursive: true }))
  const store = new RecordingStore(join(root, 'rec'))
  assert.deepEqual(await store.availableDates(), [])
  store.save('a1b2c3d4-e5f6-7890-abcd-ef0123456789', '2026-08-12T00:30:00.000Z', new Uint8Array())
  assert.deepEqual(await store.availableDates(), ['20260812'])
})

test('does not cache a failed recording directory scan', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'iaxweb-rec-scan-error-'))
  t.after(() => rmSync(root, { force: true, recursive: true }))
  const path = join(root, 'rec')
  writeFileSync(path, 'Not a directory')
  const store = new RecordingStore(path)
  await assert.rejects(store.availableDates(), { code: 'ENOTDIR' })
  rmSync(path)
  mkdirSync(join(path, '20260812'), { recursive: true })
  assert.deepEqual(await store.availableDates(), ['20260812'])
})
