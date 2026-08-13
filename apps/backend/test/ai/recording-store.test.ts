import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { RecordingStore } from '../../src/ai/recording-store.js'

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
