import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readSpeakerWav } from '../../src/ai/speaker-wav.js'
import { encodeWav } from '../../src/ai/wav.js'

test('historical WAV decoding preserves the original PCM normalization', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'iaxweb-speaker-wav-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const filename = join(root, 'recording.wav')
  const samples = Int16Array.from([-32768, -100, 0, 100, 32767])
  await writeFile(filename, encodeWav(samples))
  assert.deepEqual(await readSpeakerWav(filename), Float32Array.from(samples, value => value / 32768))
})

test('historical WAV parsing rejects truncation and a different sample rate', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'iaxweb-speaker-wav-invalid-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const filename = join(root, 'recording.wav')
  const samples = new Int16Array(8000)
  await writeFile(filename, encodeWav(samples).subarray(0, 50))
  await assert.rejects(readSpeakerWav(filename), /Truncated/)
  await writeFile(filename, encodeWav(samples, 16000))
  await assert.rejects(readSpeakerWav(filename), /8kHz/)
})
