import assert from 'node:assert/strict'
import test from 'node:test'
import { checkSpeakerQuality } from '../../src/ai/speaker-quality.mjs'

test('invalid and silent audio cannot pass the speaker quality gate', () => {
  assert.deepEqual(checkSpeakerQuality(new Float32Array(8000)), { accepted: false, reason: 'insufficient_audio' })
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 1.1]) {
    const samples = new Float32Array(8000)
    samples[500] = value
    assert.deepEqual(checkSpeakerQuality(samples), { accepted: false, reason: 'invalid_audio' })
  }
})

function noise(length: number): Float32Array {
  let state = 12345
  return Float32Array.from({ length }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return (state / 2 ** 32 - 0.5) * 0.1
  })
}

test('fixed radio tone remains rejected when there is little high-band energy', () => {
  const samples = noise(32000).map((value, i) => value + 0.3 * Math.sin(2 * Math.PI * 610 * i / 8000))
  const result = checkSpeakerQuality(samples)
  assert.equal(result.accepted, false)
  if (result.accepted)
    throw new Error('Expected rejected radio tone')
  assert.equal(result.reason, 'interference_tone')
  assert.ok(result.metrics && result.metrics.toneProminenceDb > 18)
  assert.ok(result.metrics.highBandFraction < 0.014)
})

test('broadband interference is rejected without a prominent narrow tone', () => {
  const result = checkSpeakerQuality(noise(32000))
  assert.equal(result.accepted, false)
  if (result.accepted)
    throw new Error('Expected rejected broadband interference')
  assert.equal(result.reason, 'interference_high_band')
  assert.ok(result.metrics && result.metrics.toneProminenceDb < 18)
  assert.ok(result.metrics.highBandFraction > 0.014)
})
