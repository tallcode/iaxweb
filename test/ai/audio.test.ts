import assert from 'node:assert/strict'
import test from 'node:test'

import { decodeMuLaw, rmsOfPcm, SAMPLE_RATE } from '../../src/ai/mulaw.js'
import { encodeWav } from '../../src/ai/wav.js'

test('decodes mu-law silence and full-scale values', () => {
  const samples = decodeMuLaw(new Uint8Array([0xFF, 0x80]))
  assert.equal(samples[0], 0)
  assert.ok(samples[1] && samples[1] > 30_000)
})

test('computes normalized RMS', () => {
  assert.equal(rmsOfPcm(new Int16Array([])), 0)
  assert.equal(rmsOfPcm(new Int16Array([0, 0, 0])), 0)
  const loud = rmsOfPcm(new Int16Array([16_384, 16_384]))
  assert.ok(loud > 0.49 && loud < 0.51)
})

test('encodes a valid WAV header', () => {
  const pcm = new Int16Array([0, 100, -100, 32_000])
  const wav = encodeWav(pcm)

  assert.equal(wav.length, 44 + pcm.length * 2)
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), 'RIFF')
  assert.equal(String.fromCharCode(...wav.slice(8, 12)), 'WAVE')
  assert.equal(String.fromCharCode(...wav.slice(36, 40)), 'data')

  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  assert.equal(view.getUint32(4, true), 36 + pcm.length * 2)
  assert.equal(view.getUint16(20, true), 1) // PCM
  assert.equal(view.getUint16(22, true), 1) // mono
  assert.equal(view.getUint32(24, true), SAMPLE_RATE)
  assert.equal(view.getUint16(34, true), 16) // bits per sample
  assert.equal(view.getUint32(40, true), pcm.length * 2)
})

test('round-trips PCM samples into the WAV data chunk', () => {
  const pcm = new Int16Array([1_234, -5_678])
  const wav = encodeWav(pcm)
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  assert.equal(view.getInt16(44, true), 1_234)
  assert.equal(view.getInt16(46, true), -5_678)
})
