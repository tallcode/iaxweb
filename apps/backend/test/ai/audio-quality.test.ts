import assert from 'node:assert/strict'
import test from 'node:test'
import { AudioQualityService } from '../../src/ai/audio-quality.js'

test('quality failures are rejected without any model and keep their measurement result', async () => {
  const service = new AudioQualityService()
  try {
    const invalid = new Float32Array(8000)
    invalid[0] = Number.NaN
    assert.deepEqual(await service.check(invalid), { status: 'rejected', reason: 'invalid_audio', metrics: null })
    assert.deepEqual(await service.check(new Float32Array(8000)), { status: 'rejected', reason: 'insufficient_audio', metrics: null })
  }
  finally { service.stop() }
})

test('cancelled or stopped quality checks become unknown and never pass', async () => {
  const service = new AudioQualityService()
  const abort = new AbortController()
  abort.abort()
  assert.equal((await service.check(new Float32Array(8000), abort.signal)).status, 'unknown')
  const first = service.check(new Float32Array(8000))
  const queued = service.check(new Float32Array(8000))
  service.stop()
  assert.equal((await first).status, 'unknown')
  assert.equal((await queued).status, 'unknown')
  assert.equal((await service.check(new Float32Array(8000))).status, 'unknown')
})
