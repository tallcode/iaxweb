const SAMPLE_RATE = 8000
const WINDOW_SAMPLES = SAMPLE_RATE
const HOP_SAMPLES = WINDOW_SAMPLES / 2
const FFT_SIZE = 2 * WINDOW_SAMPLES
const BINS_PER_HZ = FFT_SIZE / SAMPLE_RATE
const FUNDAMENTALS = [50, 60]
const HARMONICS = 6
const MIN_WINDOWS = 3
const MIN_PROMINENCE_DB = 12
const MIN_WINDOW_FRACTION = 0.7
const CENTER_RADIUS = 1 * BINS_PER_HZ
const CORE_RADIUS = 1.5 * BINS_PER_HZ
const NEAR_NEIGHBOR = 4 * BINS_PER_HZ
const FAR_NEIGHBOR = 9 * BINS_PER_HZ
const FIRST_LINE_BIN = FUNDAMENTALS[0] * BINS_PER_HZ - CENTER_RADIUS - FAR_NEIGHBOR
const END_LINE_BIN = FUNDAMENTALS.at(-1) * HARMONICS * BINS_PER_HZ + CENTER_RADIUS + FAR_NEIGHBOR + 1
const FIRST_ACTIVE_BIN = 20 * BINS_PER_HZ
const END_ACTIVE_BIN = 3900 * BINS_PER_HZ
const FIRST_VOICE_BIN = 300 * BINS_PER_HZ
const END_VOICE_BIN = 2000 * BINS_PER_HZ
const MIN_ACTIVE_POWER = 1e-14

// 16,000-point FFT, factored as 5³ × 2⁷ to preserve the experiment's 0.5 Hz bins.
const radices = [5, 5, 5, 2, 2, 2, 2, 2, 2, 2]
const reversed = Uint16Array.from({ length: FFT_SIZE }, (_, index) => {
  let remaining = index
  let output = 0
  for (let i = radices.length - 1; i >= 0; i--) {
    const radix = radices[i]
    output = output * radix + remaining % radix
    remaining = Math.floor(remaining / radix)
  }
  return output
})
const cosine = Float64Array.from({ length: FFT_SIZE }, (_, index) => Math.cos(2 * Math.PI * index / FFT_SIZE))
const sine = Float64Array.from({ length: FFT_SIZE }, (_, index) => -Math.sin(2 * Math.PI * index / FFT_SIZE))
const hann = Float64Array.from({ length: WINDOW_SAMPLES }, (_, index) => 0.5 - 0.5 * Math.cos(2 * Math.PI * index / WINDOW_SAMPLES))
const powerScale = 2 / (FFT_SIZE * hann.reduce((sum, value) => sum + value * value, 0))
const real = new Float64Array(FFT_SIZE)
const imaginary = new Float64Array(FFT_SIZE)
const mixedReal = new Float64Array(5)
const mixedImaginary = new Float64Array(5)
const power = new Float64Array(END_ACTIVE_BIN)

function radixFive(span) {
  const width = 5 * span
  const stride = FFT_SIZE / width
  const rootStride = FFT_SIZE / 5
  for (let base = 0; base < FFT_SIZE; base += width) {
    for (let offset = 0; offset < span; offset++) {
      for (let input = 0; input < 5; input++) {
        const index = base + offset + input * span
        const phase = offset * input * stride
        mixedReal[input] = real[index] * cosine[phase] - imaginary[index] * sine[phase]
        mixedImaginary[input] = real[index] * sine[phase] + imaginary[index] * cosine[phase]
      }
      for (let output = 0; output < 5; output++) {
        const index = base + offset + output * span
        let sumReal = 0
        let sumImaginary = 0
        for (let input = 0; input < 5; input++) {
          const phase = (input * output % 5) * rootStride
          sumReal += mixedReal[input] * cosine[phase] - mixedImaginary[input] * sine[phase]
          sumImaginary += mixedReal[input] * sine[phase] + mixedImaginary[input] * cosine[phase]
        }
        real[index] = sumReal
        imaginary[index] = sumImaginary
      }
    }
  }
}

function radixTwo(span) {
  const width = 2 * span
  const stride = FFT_SIZE / width
  for (let base = 0; base < FFT_SIZE; base += width) {
    for (let offset = 0; offset < span; offset++) {
      const left = base + offset
      const right = left + span
      const phase = offset * stride
      const rotatedReal = real[right] * cosine[phase] - imaginary[right] * sine[phase]
      const rotatedImaginary = real[right] * sine[phase] + imaginary[right] * cosine[phase]
      real[right] = real[left] - rotatedReal
      imaginary[right] = imaginary[left] - rotatedImaginary
      real[left] += rotatedReal
      imaginary[left] += rotatedImaginary
    }
  }
}

function loadSpectrum(samples, start) {
  let mean = 0
  for (let i = 0; i < WINDOW_SAMPLES; i++)
    mean += samples[start + i]
  mean /= WINDOW_SAMPLES
  real.fill(0)
  imaginary.fill(0)
  for (let i = 0; i < WINDOW_SAMPLES; i++)
    real[reversed[i]] = (samples[start + i] - mean) * hann[i]
  let span = 1
  for (const radix of radices) {
    if (radix === 5)
      radixFive(span)
    else
      radixTwo(span)
    span *= radix
  }
  for (let bin = FIRST_ACTIVE_BIN; bin < END_ACTIVE_BIN; bin++)
    power[bin] = (real[bin] ** 2 + imaginary[bin] ** 2) * powerScale
}

function quantile(values, fraction) {
  values.sort((a, b) => a - b)
  const position = (values.length - 1) * fraction
  const lower = Math.floor(position)
  return values[lower] + (values[Math.ceil(position)] - values[lower]) * (position - lower)
}

function decibels(value) {
  return 10 * Math.log10(Math.max(value, 1e-30))
}

function describeLine(frames, nominalHz, voicePower) {
  const nominal = nominalHz * BINS_PER_HZ - FIRST_LINE_BIN
  let center = nominal - CENTER_RADIUS
  let strongest = -1
  for (let bin = center; bin <= nominal + CENTER_RADIUS; bin++) {
    const median = quantile(frames.map(frame => frame[bin]), 0.5)
    if (median > strongest) {
      strongest = median
      center = bin
    }
  }

  const neighborPowers = new Float64Array(2 * (FAR_NEIGHBOR - NEAR_NEIGHBOR + 1))
  const levels = []
  const prominences = []
  let aboveThreshold = 0
  for (const frame of frames) {
    let level = 0
    for (let bin = center - CORE_RADIUS; bin <= center + CORE_RADIUS; bin++)
      level += frame[bin]
    for (let offset = NEAR_NEIGHBOR; offset <= FAR_NEIGHBOR; offset++) {
      const index = 2 * (offset - NEAR_NEIGHBOR)
      neighborPowers[index] = frame[center - offset]
      neighborPowers[index + 1] = frame[center + offset]
    }
    const background = quantile(neighborPowers, 0.5) * (2 * CORE_RADIUS + 1)
    const prominence = decibels(level) - decibels(background)
    if (prominence >= MIN_PROMINENCE_DB)
      aboveThreshold++
    levels.push(level)
    prominences.push(prominence)
  }
  const p50Dbfs = decibels(quantile(levels, 0.5))
  return {
    nominalHz,
    frequencyHz: (center + FIRST_LINE_BIN) / BINS_PER_HZ,
    medianProminenceDb: quantile(prominences, 0.5),
    fractionAtLeast12Db: aboveThreshold / frames.length,
    p50Dbfs,
    relativeVoiceDb: voicePower > 0 ? p50Dbfs - decibels(voicePower) : null,
  }
}

// Uses normalized 8 kHz PCM. The shared FFT buffers are used synchronously.
export function detectMainsDiagnostics(samples) {
  const frames = []
  const voice = []
  for (let start = 0; start + WINDOW_SAMPLES <= samples.length; start += HOP_SAMPLES) {
    loadSpectrum(samples, start)
    let activePower = 0
    let voicePower = 0
    for (let bin = FIRST_ACTIVE_BIN; bin < END_ACTIVE_BIN; bin++)
      activePower += power[bin]
    if (!(activePower > MIN_ACTIVE_POWER))
      continue
    for (let bin = FIRST_VOICE_BIN; bin < END_VOICE_BIN; bin++)
      voicePower += power[bin]
    frames.push(power.slice(FIRST_LINE_BIN, END_LINE_BIN))
    voice.push(voicePower)
  }
  if (frames.length === 0)
    return null
  if (frames.length < MIN_WINDOWS)
    return []

  const voicePower = quantile(voice, 0.8)
  const diagnostics = []
  for (const fundamentalHz of FUNDAMENTALS) {
    const lines = []
    for (let order = 1; order <= HARMONICS; order++) {
      const line = describeLine(frames, fundamentalHz * order, voicePower)
      if (line.fractionAtLeast12Db >= MIN_WINDOW_FRACTION)
        lines.push(line)
    }
    if (lines[0]?.nominalHz === fundamentalHz || lines.length >= 3)
      diagnostics.push({ fundamentalHz, lines })
  }
  return diagnostics
}
