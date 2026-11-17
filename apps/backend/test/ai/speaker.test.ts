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

test('a timed-out worker rejects waiting jobs and backs off without hanging', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const extractor = new SpeakerExtractor('/missing/model.onnx')
  try {
    const first = assert.rejects(extractor.extract(new Float32Array(8000), 1000), /timed out/)
    const second = assert.rejects(extractor.extract(new Float32Array(8000), 1000), /timed out/)
    t.mock.timers.tick(10_000)
    await Promise.all([first, second])
    await assert.rejects(extractor.extract(new Float32Array(8000), 1000), /timed out/)
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
