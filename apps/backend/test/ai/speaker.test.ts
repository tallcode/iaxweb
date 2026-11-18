import assert from 'node:assert/strict'
import test from 'node:test'
import { SpeakerExtractor } from '../../src/ai/speaker.js'

test('insufficient voiced audio does not start a native worker', async () => {
  const extractor = new SpeakerExtractor('/missing/model.onnx')
  try {
    assert.equal((await extractor.extract(new Float32Array(8000), 999)).status, 'unavailable')
  }
  finally { extractor.stop() }
})

test('a timed-out process exits before retry; concurrent jobs are rejected without queueing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const extractor = new SpeakerExtractor('/missing/model.onnx')
  try {
    const first = assert.rejects(extractor.extract(new Float32Array(8000), 1000), /timed out/)
    const second = assert.rejects(extractor.extract(new Float32Array(8000), 1000), /queue full/)
    t.mock.timers.tick(30_000)
    await Promise.all([first, second])
    await assert.rejects(extractor.extract(new Float32Array(8000), 1000), /timed out/)
  }
  finally { extractor.stop() }
})

test('oversized recordings are rejected before starting native inference', async () => {
  const extractor = new SpeakerExtractor('/missing/model.onnx')
  try {
    const result = await extractor.extract(new Float32Array(20 * 8000 + 1), 20_000)
    assert.equal(result.status, 'unavailable')
    assert.equal(result.reason, 'audio_too_long')
    assert.equal(extractor.backingOff, false)
  }
  finally { extractor.stop() }
})

test('shutdown rejects in-flight work and prevents future extraction', async () => {
  const extractor = new SpeakerExtractor('/missing/model.onnx')
  const pending = assert.rejects(extractor.extract(new Float32Array(8000), 1000), /stopped/)
  extractor.stop()
  await pending
  await assert.rejects(extractor.extract(new Float32Array(8000), 1000), /stopped/)
})
