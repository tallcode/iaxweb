import assert from 'node:assert/strict'
import test from 'node:test'
import { createSpeakerMeasurements } from '../../src/ai/speaker-measurements.js'
import { SpeakerExtractor } from '../../src/ai/speaker.js'

test('insufficient voiced audio does not start a native worker', async () => {
  const extractor = new SpeakerExtractor('/missing/model.onnx')
  try {
    assert.equal((await extractor.extract(new Float32Array(8000), 999)).status, 'unavailable')
  }
  finally { extractor.stop() }
})

test('timeout rejects the bounded queue, and no process retries during backoff', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const extractor = new SpeakerExtractor('/missing/model.onnx')
  const measurements = createSpeakerMeasurements()
  const queuedMeasurements = createSpeakerMeasurements()
  try {
    const first = assert.rejects(extractor.extract(new Float32Array(8000), 1000, undefined, measurements), /timed out/)
    const measuredQueued = assert.rejects(extractor.extract(new Float32Array(8000), 1000, undefined, queuedMeasurements), /timed out/)
    const queued = Array.from({ length: 3 }, () => assert.rejects(extractor.extract(new Float32Array(8000), 1000), /timed out/))
    await assert.rejects(extractor.extract(new Float32Array(8000), 1000), /queue full/)
    t.mock.timers.tick(60_000)
    await Promise.all([first, measuredQueued, ...queued])
    assert.equal(typeof measurements.processTotalMs, 'number')
    assert.equal(typeof measurements.processExitMs, 'number')
    assert.equal(typeof queuedMeasurements.queueWaitMs, 'number')
    assert.equal(queuedMeasurements.processTotalMs, null)
    await assert.rejects(extractor.extract(new Float32Array(8000), 1000), /timed out/)
  }
  finally { extractor.stop() }
})

test('oversized recordings are rejected before starting native inference', async () => {
  const extractor = new SpeakerExtractor('/missing/model.onnx')
  try {
    const result = await extractor.extract(new Float32Array(60 * 8000 + 1), 60_000)
    assert.equal(result.status, 'unavailable')
    assert.equal(result.reason, 'audio_too_long_60s')
    assert.equal(extractor.backingOff, false)
  }
  finally { extractor.stop() }
})

test('shutdown rejects in-flight work and prevents future extraction', async () => {
  const extractor = new SpeakerExtractor('/missing/model.onnx')
  const pending = assert.rejects(extractor.extract(new Float32Array(8000), 1000), /stopped/)
  const queued = assert.rejects(extractor.extract(new Float32Array(8000), 1000), /stopped/)
  extractor.stop()
  await Promise.all([pending, queued])
  await assert.rejects(extractor.extract(new Float32Array(8000), 1000), /stopped/)
})

test('queue waiting time is excluded from each extraction timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const extractor = new SpeakerExtractor('/missing/model.onnx')
  try {
    // Silent audio is rejected by quality checking, without loading a model.
    const first = extractor.extract(new Float32Array(8000), 1000)
    const second = extractor.extract(new Float32Array(8000), 1000)
    t.mock.timers.tick(50_000)
    assert.equal((await first).status, 'unavailable')
    t.mock.timers.tick(20_000)
    assert.equal((await second).status, 'unavailable')
  }
  finally { extractor.stop() }
})

test('cancelling a queued request releases its slot without cancelling the running task', async () => {
  const extractor = new SpeakerExtractor('/missing/model.onnx')
  const controller = new AbortController()
  const measurements = createSpeakerMeasurements()
  try {
    const first = extractor.extract(new Float32Array(8000), 1000)
    const cancelled = assert.rejects(extractor.extract(new Float32Array(8000), 1000, controller.signal, measurements), /cancelled/)
    controller.abort()
    await cancelled
    assert.equal(typeof measurements.queueWaitMs, 'number')
    assert.equal(measurements.processTotalMs, null)
    assert.equal((await first).status, 'unavailable')
    assert.equal(extractor.backingOff, false)
  }
  finally { extractor.stop() }
})

test('quality rejection measures the worker but leaves inference stages unexecuted', async () => {
  const extractor = new SpeakerExtractor('/missing/model.onnx')
  const measurements = createSpeakerMeasurements()
  try {
    const result = await extractor.extract(new Float32Array(8000), 1000, undefined, measurements)
    assert.equal(result.status, 'unavailable')
    assert.equal(typeof measurements.processStartupMs, 'number')
    assert.equal(typeof measurements.qualityCheckMs, 'number')
    assert.equal(typeof measurements.processExitMs, 'number')
    assert.equal(typeof measurements.processTotalMs, 'number')
    assert.equal(measurements.modelValidationMs, null)
    assert.equal(measurements.modelLoadMs, null)
    assert.equal(measurements.embeddingComputeMs, null)
  }
  finally { extractor.stop() }
})
