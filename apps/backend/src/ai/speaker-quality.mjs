import { checkLocalInterference, quantile } from './speaker-quality-local.mjs'
import { detectMainsDiagnostics } from './speaker-quality-mains.mjs'

// Joint spectral and temporal quality checks for 8 kHz radio audio.
const SAMPLE_RATE = 8000
const MIN_SAMPLES = SAMPLE_RATE
const EDGE_SAMPLES = SAMPLE_RATE / 2
const FRAME_SAMPLES = 256
const HOP_SAMPLES = 64
const FFT_SIZE = 1024
const BLOCK_SAMPLES = SAMPLE_RATE / 10
const FRAME_POWER_SCALE = 2 / (FFT_SIZE * FRAME_SAMPLES * 3 / 8)
const TONE_LIMIT_DB = 18
const HIGH_BAND_LIMIT = 0.014
// Equal-width 3.0-3.3 kHz and 3.6-3.9 kHz bands. -6 dB is roughly a 4:1 power drop.
const HIGH_BAND_ROLLOFF_LIMIT_DB = -6
const TEMPORAL_ROLLOFF_LIMIT_DB = -8.5
const HIGH_BAND_DYNAMIC_LIMIT_DB = 15
const HIGH_BAND_PERSISTENCE_LIMIT_DB = -37
const NOISE_PERSISTENCE_LIMIT_DB = -20.3
const STRONG_NOISE_PERSISTENCE_LIMIT_DB = -20.8
const STRONG_HIGH_FLOOR_DB = -21
const HIGH_FLOOR_LIMIT_DB = -24.5
const HIGH_SPREAD_LIMIT_DB = 10

function spectrumPlan(size, windowSize) {
  const real = new Float64Array(size)
  const imaginary = new Float64Array(size)
  const power = new Float64Array(size / 2 + 1)
  const window = Float64Array.from({ length: windowSize }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / windowSize))
  const reversed = new Uint32Array(size)
  const bits = Math.log2(size)
  for (let i = 0; i < size; i++) {
    let value = i
    for (let j = 0; j < bits; j++) {
      reversed[i] = (reversed[i] << 1) | (value & 1)
      value >>>= 1
    }
  }
  const cosine = Float64Array.from({ length: size / 2 }, (_, i) => Math.cos(2 * Math.PI * i / size))
  const sine = Float64Array.from({ length: size / 2 }, (_, i) => -Math.sin(2 * Math.PI * i / size))
  return (samples, start, detrend) => {
    let mean = 0
    if (detrend) {
      for (let i = 0; i < windowSize; i++) mean += samples[start + i]
      mean /= windowSize
    }
    real.fill(0)
    imaginary.fill(0)
    for (let i = 0; i < windowSize; i++) real[reversed[i]] = (samples[start + i] - mean) * window[i]
    for (let width = 2; width <= size; width *= 2) {
      const half = width / 2
      const stride = size / width
      for (let base = 0; base < size; base += width) {
        for (let j = 0; j < half; j++) {
          const a = base + j
          const b = a + half
          const index = j * stride
          const re = real[b] * cosine[index] - imaginary[b] * sine[index]
          const im = real[b] * sine[index] + imaginary[b] * cosine[index]
          real[b] = real[a] - re
          imaginary[b] = imaginary[a] - im
          real[a] += re
          imaginary[a] += im
        }
      }
    }
    for (let i = 0; i < power.length; i++) power[i] = real[i] ** 2 + imaginary[i] ** 2
    return power
  }
}

const shortSpectrum = spectrumPlan(FFT_SIZE, FRAME_SAMPLES)
const longSpectrum = spectrumPlan(2048, 2048)

function sumPower(power, from, to) {
  let sum = 0
  for (let bin = from; bin < to; bin++) sum += power[bin]
  return sum
}

function measureFrame(power, start) {
  // FFT-bin ranges for 150–2000, 2100–3900, 300–2000, and 300–3900 Hz.
  const voice = sumPower(power, 20, 256)
  const floor = sumPower(power, 269, 500)
  const blockVoice = sumPower(power, 39, 256) * FRAME_POWER_SCALE
  const broad = sumPower(power, 39, 500) * FRAME_POWER_SCALE
  const high = sumPower(power, 384, 500) * FRAME_POWER_SCALE

  // Unscaled powers for the local-event test. Its baseline uses the 300–1800
  // Hz band and its three interference bands span 1800–3900 Hz.
  const localVoice = sumPower(power, 39, 231)
  const localBands = [sumPower(power, 231, 308), sumPower(power, 308, 397), sumPower(power, 397, 500)]
  const localEnergy = localBands[0] + localBands[1] + localBands[2]
  let logPower = 0
  for (let bin = 231; bin < 500; bin++) logPower += Math.log(Math.max(power[bin], 1e-25))
  const localBins = 500 - 231
  const flatness = Math.exp(logPower / localBins) / Math.max(localEnergy / localBins, 1e-25)

  return { center: start + FRAME_SAMPLES / 2, voice, floor, blockVoice, broad, high, localVoice, localBands, flatness }
}

function ratioDb(numerator, denominator) {
  return numerator > 0 && denominator > 0 ? 10 * Math.log10(numerator / denominator) : null
}

function noisePersistence(frames, sampleCount) {
  const upperVoice = quantile(frames.map(frame => frame.voice), 0.8)
  const reference = quantile(frames.filter(frame => frame.voice >= upperVoice).map(frame => frame.voice), 0.5)
  if (reference <= 0)
    return null

  const scores = []
  let from = 0
  let to = 0
  for (let start = 0; start + SAMPLE_RATE <= sampleCount; start += EDGE_SAMPLES) {
    while (frames[from]?.center < start) from++
    while (frames[to]?.center < start + SAMPLE_RATE) to++
    const window = frames.slice(from, to)
    const quietVoice = quantile(window.map(frame => frame.voice), 0.2)
    const floor = quantile(window.filter(frame => frame.voice <= quietVoice).map(frame => frame.floor), 0.5)
    scores.push(10 * Math.log10(Math.max(floor / reference, 1e-30)))
  }
  return scores.length ? quantile(scores, 0.1) : null
}

function wholeRecordSpread(frames, sampleCount) {
  const count = Math.floor(sampleCount / BLOCK_SAMPLES)
  if (count < 20)
    return null
  const blocks = Array.from({ length: count }, () => ({ frames: 0, voice: 0, broad: 0, high: 0 }))
  for (const frame of frames) {
    const block = blocks[Math.floor(frame.center / BLOCK_SAMPLES)]
    if (!block)
      break
    block.frames++
    block.voice += frame.blockVoice
    block.broad += frame.broad
    block.high += frame.high
  }
  for (const block of blocks) {
    block.voice /= block.frames
    block.broad /= block.frames
    block.high /= block.frames
  }
  blocks.sort((a, b) => a.voice - b.voice)
  const fifth = Math.floor(count / 5)
  const floor = quantile(blocks.slice(0, fifth).map(block => block.broad), 0.5)
  const typical = quantile(blocks.slice(fifth, -fifth).map(block => block.broad), 0.5)
  if (floor <= 0 || typical <= floor)
    return null

  const high = blocks.map(block => block.high)
  return ratioDb(quantile(high, 0.9), quantile(high, 0.1))
}

function noiseMetrics(frames, sampleCount) {
  const active = frames.filter(frame => frame.broad > 1e-15)
  if (!active.length)
    return { noisePersistenceDb: null, relativeHighFloorDb: null, highBandSpreadDb: null }
  const activeVoice = active.map(frame => frame.blockVoice)
  const floor = quantile(active.map(frame => frame.high), 0.2)
  const speech = quantile(activeVoice, 0.8) - quantile(activeVoice, 0.2)
  return {
    noisePersistenceDb: noisePersistence(frames, sampleCount),
    relativeHighFloorDb: ratioDb(floor, speech),
    highBandSpreadDb: wholeRecordSpread(frames, sampleCount),
  }
}

function measureSpectra(samples, frames) {
  let total = 0
  let high = 0
  let lowerHigh = 0
  let upperHigh = 0
  const highFrames = []
  // scipy STFT: periodic Hann256, hop64, FFT1024, no boundary padding.
  for (let start = 0; start + FRAME_SAMPLES <= samples.length; start += HOP_SAMPLES) {
    const power = shortSpectrum(samples, start, false)
    let frameHigh = 0
    for (let i = 20; i <= 499; i++) {
      const value = power[i] / (128 * 128) + 1e-16
      total += value
      if (i >= 384) {
        high += value
        frameHigh += value
      }
      if (i >= 384 && i <= 422)
        lowerHigh += value
      if (i >= 461 && i <= 499)
        upperHigh += value
    }
    highFrames.push(frameHigh)
    if (frames)
      frames.push(measureFrame(power, start))
  }
  const highBandFraction = high / total
  const highBandRolloffDb = 10 * Math.log10(Math.max(upperHigh, 1e-30) / Math.max(lowerHigh, 1e-30))

  // Use the interior of the distribution so a click cannot determine the range.
  const highBandDynamicDb = 10 * Math.log10(Math.max(quantile(highFrames, 0.9), 1e-30) / Math.max(quantile(highFrames, 0.1), 1e-30))

  // Welch PSD: periodic Hann2048, 50% overlap, constant detrending.
  // The common density normalization cancels in the peak/background ratio.
  const average = new Float64Array(1025)
  for (let start = 0; start + 2048 <= samples.length; start += 1024) {
    const power = longSpectrum(samples, start, true)
    for (let i = 0; i < average.length; i++) average[i] += power[i]
  }
  let toneProminenceDb = 0
  for (let i = 65; i <= 819; i++) {
    if (average[i] <= average[i - 1] || average[i] <= average[i + 1])
      continue
    const neighbors = []
    for (let distance = 6; distance <= 15; distance++) neighbors.push(average[i - distance], average[i + distance])
    neighbors.sort((a, b) => a - b)
    const median = (neighbors[9] + neighbors[10]) / 2
    // A pure tone can have a zero background. Keep the metric finite.
    toneProminenceDb = Math.max(toneProminenceDb, 10 * Math.log10(average[i] / Math.max(median, 1e-30)))
  }
  return { highBandFraction, toneProminenceDb, highBandRolloffDb, highBandDynamicDb }
}

function hasHighBandInterference({ highBandFraction, highBandRolloffDb, highBandDynamicDb }) {
  return highBandFraction > HIGH_BAND_LIMIT && (highBandRolloffDb > HIGH_BAND_ROLLOFF_LIMIT_DB
    || (highBandRolloffDb > TEMPORAL_ROLLOFF_LIMIT_DB && highBandDynamicDb > HIGH_BAND_DYNAMIC_LIMIT_DB))
}

function hasHiss({ noisePersistenceDb, relativeHighFloorDb, highBandSpreadDb }) {
  const strongFloor = relativeHighFloorDb !== null && relativeHighFloorDb >= STRONG_HIGH_FLOOR_DB
  const limit = strongFloor ? STRONG_NOISE_PERSISTENCE_LIMIT_DB : NOISE_PERSISTENCE_LIMIT_DB
  return noisePersistenceDb !== null && noisePersistenceDb > limit
    && ((relativeHighFloorDb !== null && relativeHighFloorDb >= HIGH_FLOOR_LIMIT_DB)
      || (highBandSpreadDb !== null && highBandSpreadDb <= HIGH_SPREAD_LIMIT_DB))
}

function checkQuality(original, useLatest) {
  for (const value of original) {
    if (!Number.isFinite(value) || Math.abs(value) > 1)
      return { accepted: false, reason: 'invalid_audio' }
  }
  if (original.length < MIN_SAMPLES)
    return { accepted: false, reason: 'insufficient_audio' }

  // The quality analysis excludes half a second at each edge when it leaves
  // a full second. Local event times and mains analysis refer to the original.
  const edge = original.length >= MIN_SAMPLES + 2 * EDGE_SAMPLES ? EDGE_SAMPLES : 0
  const samples = original.subarray(edge, original.length - edge)
  let energy = 0
  for (const value of samples) energy += value * value
  if (energy === 0)
    return { accepted: false, reason: 'insufficient_audio' }

  const frames = useLatest ? [] : null
  const spectral = measureSpectra(samples, frames)
  const metrics = frames
    ? { ...spectral, ...noiseMetrics(frames, samples.length), mainsDiagnostics: detectMainsDiagnostics(original) }
    : spectral
  if (metrics.toneProminenceDb > TONE_LIMIT_DB)
    return { accepted: false, reason: 'interference_tone', metrics }
  const persistence = metrics.noisePersistenceDb ?? null
  if (hasHighBandInterference(metrics) && (persistence === null || persistence > HIGH_BAND_PERSISTENCE_LIMIT_DB))
    return { accepted: false, reason: 'interference_high_band', metrics }
  if (frames) {
    if (hasHiss(metrics))
      return { accepted: false, reason: 'interference_hiss', metrics }
    const reason = checkLocalInterference(original, frames, edge)
    if (reason)
      return { accepted: false, reason, metrics }
  }
  return { accepted: true, metrics }
}

// Existing historical decisions continue to use the original quality rules.
export function checkLegacySpeakerQuality(samples) {
  return checkQuality(samples, false)
}

export function checkSpeakerQuality(samples) {
  return checkQuality(samples, true)
}
