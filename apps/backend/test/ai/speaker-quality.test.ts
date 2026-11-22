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

function audioWithEdgeTones(length: number): Float32Array {
  // A two-pole low-pass has no comb-filter notches that can look like a
  // narrowband interferer in the local peak/background measurement.
  let previous = 0
  let filtered = 0
  const interior = noise(length).map((sample) => {
    previous += 0.1 * (sample - previous)
    filtered += 0.1 * (previous - filtered)
    return filtered
  })
  return Float32Array.from({ length }, (_, i) => {
    if (i < 4000 || i >= length - 4000)
      return 0.3 * Math.sin(2 * Math.PI * 610 * i / 8000)
    return interior[i]!
  })
}

test('two-second audio ignores half-second radio tones at both edges without changing the waveform', () => {
  const samples = audioWithEdgeTones(16000)
  const original = samples.slice()
  const quality = checkSpeakerQuality(samples)
  assert.equal(quality.accepted, true, JSON.stringify(quality))
  assert.deepEqual(samples, original)
})

test('shorter audio retains its edges instead of leaving less than one second to inspect', () => {
  const result = checkSpeakerQuality(audioWithEdgeTones(15999))
  assert.equal(result.accepted, false)
  if (!result.accepted)
    assert.equal(result.reason, 'interference_tone')
})

test('trimming does not allow silent interiors or invalid edge samples to pass', () => {
  const samples = audioWithEdgeTones(16000)
  samples.fill(0, 4000, 12000)
  assert.deepEqual(checkSpeakerQuality(samples), { accepted: false, reason: 'insufficient_audio' })
  samples[0] = Number.NaN
  assert.deepEqual(checkSpeakerQuality(samples), { accepted: false, reason: 'invalid_audio' })
})

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

function coloredNoise(tapWeight: number, modulated: boolean): Float32Array {
  let previous = 0
  // A two-tap filter changes spectral tilt without fixed tones. Alternating
  // levels create time variation independently of that spectral shape.
  return noise(64_000).map((sample, i) => {
    const value = (sample + tapWeight * previous) / (1 + tapWeight)
    previous = sample
    const gain = modulated && Math.floor(i / 2000) % 2 === 0 ? 0.08 : 1
    return value * gain
  })
}

test('high-band energy with spectral rolloff does not alone reject steady audio', () => {
  const result = checkSpeakerQuality(coloredNoise(0.8, false))
  assert.equal(result.accepted, true, JSON.stringify(result))
  assert.ok(result.metrics)
  assert.ok(result.metrics.highBandFraction > 0.014)
  assert.ok(result.metrics.highBandRolloffDb < -6 && result.metrics.highBandRolloffDb > -8.5)
  assert.ok(result.metrics.highBandDynamicDb < 15)
})

test('varying colored interference is rejected even with moderate high-band rolloff', () => {
  const result = checkSpeakerQuality(coloredNoise(0.8, true))
  assert.equal(result.accepted, false, JSON.stringify(result))
  if (result.accepted)
    throw new Error('Expected rejected varying high-band interference')
  assert.equal(result.reason, 'interference_high_band')
  assert.ok(result.metrics)
  assert.ok(result.metrics.toneProminenceDb < 18)
  assert.ok(result.metrics.highBandFraction > 0.014)
  assert.ok(result.metrics.highBandRolloffDb < -6 && result.metrics.highBandRolloffDb > -8.5)
  assert.ok(result.metrics.highBandDynamicDb > 15)
})

test('time variation with steep high-band rolloff remains eligible', () => {
  const result = checkSpeakerQuality(coloredNoise(1, true))
  assert.equal(result.accepted, true, JSON.stringify(result))
  assert.ok(result.metrics)
  assert.ok(result.metrics.highBandFraction > 0.014)
  assert.ok(result.metrics.highBandRolloffDb < -8.5)
  assert.ok(result.metrics.highBandDynamicDb > 15)
})
