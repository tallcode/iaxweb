// Joint spectral and temporal radio quality gate, checked against 13 user-labeled
// recordings. These heuristics are not a general interference classifier.
const SAMPLE_RATE = 8000
const MIN_SAMPLES = SAMPLE_RATE
const EDGE_SAMPLES = SAMPLE_RATE / 2
const TONE_LIMIT_DB = 18
const HIGH_BAND_LIMIT = 0.014
// Equal-width 3.0-3.3 kHz and 3.6-3.9 kHz bands. -6 dB is roughly a 4:1 power drop.
const HIGH_BAND_ROLLOFF_LIMIT_DB = -6
const TEMPORAL_ROLLOFF_LIMIT_DB = -8.5
const HIGH_BAND_DYNAMIC_LIMIT_DB = 15

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

const shortSpectrum = spectrumPlan(1024, 256)
const longSpectrum = spectrumPlan(2048, 2048)

// Synchronous, bounded workspace; called serially inside the speaker Worker.
export function checkSpeakerQuality(samples) {
  for (const value of samples) {
    if (!Number.isFinite(value) || Math.abs(value) > 1)
      return { accepted: false, reason: 'invalid_audio' }
  }
  if (samples.length < MIN_SAMPLES)
    return { accepted: false, reason: 'insufficient_audio' }

  // Trim 500 ms per edge only when at least one second remains. This view is
  // used only for the quality gate; the Worker still embeds the full recording.
  if (samples.length >= MIN_SAMPLES + 2 * EDGE_SAMPLES)
    samples = samples.subarray(EDGE_SAMPLES, samples.length - EDGE_SAMPLES)
  let energy = 0
  for (const value of samples) energy += value * value
  if (energy === 0)
    return { accepted: false, reason: 'insufficient_audio' }

  let total = 0
  let high = 0
  let lowerHigh = 0
  let upperHigh = 0
  const highFrames = []
  // scipy STFT: periodic Hann256, hop64, FFT1024, no boundary padding.
  for (let start = 0; start + 256 <= samples.length; start += 64) {
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
  }
  const highBandFraction = high / total
  const highBandRolloffDb = 10 * Math.log10(Math.max(upperHigh, 1e-30) / Math.max(lowerHigh, 1e-30))

  // Measure time variation without letting a single click or extreme frame
  // determine the range. At the worker's 60s limit this holds fewer than 7500
  // frame energies; no extra FFT or inference model is needed.
  highFrames.sort((a, b) => a - b)
  const quantile = (q) => {
    const at = (highFrames.length - 1) * q
    const index = Math.floor(at)
    return highFrames[index] + (highFrames[Math.min(index + 1, highFrames.length - 1)] - highFrames[index]) * (at - index)
  }
  const highBandDynamicDb = 10 * Math.log10(Math.max(quantile(0.9), 1e-30) / Math.max(quantile(0.1), 1e-30))

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
  const metrics = { highBandFraction, toneProminenceDb, highBandRolloffDb, highBandDynamicDb }
  if (toneProminenceDb > TONE_LIMIT_DB)
    return { accepted: false, reason: 'interference_tone', metrics }
  if (highBandFraction > HIGH_BAND_LIMIT && highBandRolloffDb > HIGH_BAND_ROLLOFF_LIMIT_DB)
    return { accepted: false, reason: 'interference_high_band', metrics }
  // Time variation alone also occurs in clean speech. Require both excessive
  // high-band energy and limited rolloff before using it to reject audio.
  if (highBandFraction > HIGH_BAND_LIMIT && highBandRolloffDb > TEMPORAL_ROLLOFF_LIMIT_DB && highBandDynamicDb > HIGH_BAND_DYNAMIC_LIMIT_DB)
    return { accepted: false, reason: 'interference_high_band', metrics }
  return { accepted: true, metrics }
}
