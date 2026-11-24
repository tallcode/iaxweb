const SAMPLE_RATE = 8000
const HOP = 64
const SIDE_FRAMES = 40
const GUARD_FRAMES = 14
const MIN_BOOST_DB = 7
const MIN_FLATNESS = 0.32
const MIN_EVENT_FRAMES = 6
const MAX_EVENT_FRAMES = 40
const MAX_FRAME_DISTANCE = 2
const MIN_TOP_DB = -16
const STRICT_TOP_DB = -12

// Three-section Butterworth bandpasses and their steady-state initial states.
// Coefficients match the offline zero-phase analysis at 8 kHz.
const HIGH_BANDPASS = [
  [0.17665677487203935, -0.3533135497440787, 0.17665677487203935, -0.284996510855901, 0.39838153079638733, -0.17665677487203935, 0.17665677487203935],
  [1, 0, -1, 0.7626037273826872, -0.019637477771376834, 0, 0],
  [1, 2, 1, 1.8000254759821552, 0.8375791701629953, 0, 0],
]
const LOW_BANDPASS = [
  [0.10595730629110556, 0.21191461258221111, 0.10595730629110556, -0.2558576216685312, 0.39018204515260185, 0.26768291196553157, -0.03983039821953364],
  [1, 0, -1, -1.0291464628676952, 0.13831675995606113, -0.3736402182566364, -0.3736402182566372],
  [1, -2, 1, -1.8836898375676185, 0.8976101716861296, 0, 0],
]
const FILTER_PADDING = 21
const PEAK_BLOCK = 40
const LOW_BLOCK = 80

export function quantile(values, fraction) {
  const sorted = values.slice().sort((a, b) => a - b)
  const rank = (sorted.length - 1) * fraction
  const index = Math.floor(rank)
  return sorted[index] + (rank - index) * (sorted[Math.ceil(rank)] - sorted[index])
}

function localFrames(frames) {
  const voices = frames.filter(frame => frame.localVoice + frame.localBands[0] + frame.localBands[1] + frame.localBands[2] > 1e-20)
    .map(frame => frame.localVoice)
  const reference = voices.length ? quantile(voices, 0.8) : 0
  const baselineMin = reference * 1e-7 + 1e-25
  const prefixes = Array.from({ length: 3 }, (_, band) => {
    const sum = new Float64Array(frames.length + 1)
    frames.forEach((frame, index) => {
      sum[index + 1] = sum[index] + frame.localBands[band]
    })
    return sum
  })

  const candidates = []
  const context = SIDE_FRAMES + GUARD_FRAMES
  for (let index = context; index + context < frames.length; index++) {
    const { localBands, flatness } = frames[index]
    const topDb = 10 * Math.log10(Math.max(localBands[2], 1e-25) / Math.max(reference, 1e-25))
    if (topDb < MIN_TOP_DB || flatness < MIN_FLATNESS)
      continue
    const rises = prefixes.map((sum, band) => {
      const left = (sum[index - GUARD_FRAMES] - sum[index - context]) / SIDE_FRAMES
      const right = (sum[index + context] - sum[index + GUARD_FRAMES]) / SIDE_FRAMES
      return 10 * Math.log10(Math.max(localBands[band], 1e-25) / Math.max(left, right, baselineMin))
    })
    if (Math.min(...rises) >= MIN_BOOST_DB)
      candidates.push({ index, topDb })
  }
  return candidates
}

function groupEvents(candidates, frames, edge, topLimit) {
  const events = []
  let first
  let last
  let peakRelativeTopDb
  function close() {
    if (first === undefined)
      return
    const duration = last - first + 1
    if (duration >= MIN_EVENT_FRAMES && duration <= MAX_EVENT_FRAMES) {
      events.push({
        start: (frames[first].center + edge - HOP / 2) / SAMPLE_RATE,
        end: (frames[last].center + edge + HOP / 2) / SAMPLE_RATE,
        peakRelativeTopDb,
      })
    }
    first = undefined
  }

  for (const { index, topDb } of candidates) {
    if (topDb < topLimit)
      continue
    if (first !== undefined && index - last > MAX_FRAME_DISTANCE)
      close()
    if (first === undefined) {
      first = index
      peakRelativeTopDb = topDb
    }
    last = index
    peakRelativeTopDb = Math.max(peakRelativeTopDb, topDb)
  }
  close()
  return events
}

function filterForward(samples, sections) {
  const initial = samples[0]
  for (const [b0, b1, b2, a1, a2, z0, z1] of sections) {
    let state0 = z0 * initial
    let state1 = z1 * initial
    for (let index = 0; index < samples.length; index++) {
      const input = samples[index]
      const output = b0 * input + state0
      state0 = b1 * input - a1 * output + state1
      state1 = b2 * input - a2 * output
      samples[index] = output
    }
  }
}

function zeroPhaseFilter(samples, sections) {
  const padded = new Float64Array(samples.length + 2 * FILTER_PADDING)
  const last = samples.length - 1
  padded.set(samples, FILTER_PADDING)
  for (let offset = 1; offset <= FILTER_PADDING; offset++) {
    padded[FILTER_PADDING - offset] = 2 * samples[0] - samples[offset]
    padded[FILTER_PADDING + last + offset] = 2 * samples[last] - samples[last - offset]
  }
  filterForward(padded, sections)
  padded.reverse()
  filterForward(padded, sections)
  padded.reverse()
  return padded.subarray(FILTER_PADDING, FILTER_PADDING + samples.length)
}

function blockEnergy(samples, block) {
  return Array.from({ length: Math.floor(samples.length / block) }, (_, index) => {
    let sum = 0
    for (let i = index * block; i < (index + 1) * block; i++) sum += samples[i] ** 2
    return sum / block
  })
}

function assessPeak(values, peak) {
  const height = values[peak]
  let leftBase = peak
  let rightBase = peak
  for (let index = peak - 1; index >= Math.max(0, peak - 9) && values[index] <= height; index--) {
    if (values[index] < values[leftBase])
      leftBase = index
  }
  for (let index = peak + 1; index <= Math.min(values.length - 1, peak + 9) && values[index] <= height; index++) {
    if (values[index] < values[rightBase])
      rightBase = index
  }

  const prominence = height - Math.max(values[leftBase], values[rightBase])
  const half = height - prominence / 2
  let left = peak
  let right = peak
  while (left > leftBase && values[left] > half) left--
  while (right < rightBase && values[right] > half) right++
  const leftCrossing = left + (values[left] < half ? (half - values[left]) / (values[left + 1] - values[left]) : 0)
  const rightCrossing = right - (values[right] < half ? (half - values[right]) / (values[right - 1] - values[right]) : 0)
  return { prominence, width: rightCrossing - leftCrossing }
}

function separatedPeaks(values) {
  const maxima = []
  for (let index = 1; index + 1 < values.length; index++) {
    if (values[index] <= values[index - 1])
      continue
    let end = index + 1
    while (end < values.length && values[end] === values[index]) end++
    if (end < values.length && values[end] < values[index])
      maxima.push(Math.floor((index + end - 1) / 2))
    index = end - 1
  }
  maxima.sort((a, b) => values[b] - values[a] || b - a)
  const excluded = new Uint8Array(values.length)
  const selected = []
  for (const peak of maxima) {
    if (excluded[peak])
      continue
    selected.push(peak)
    excluded.fill(1, Math.max(0, peak - 2), Math.min(excluded.length, peak + 3))
  }
  return selected.sort((a, b) => a - b)
}

function peakClusters(samples) {
  const overall = blockEnergy(samples, PEAK_BLOCK)
  const active = overall.filter(power => power > 1e-14)
  if (!active.length)
    return []
  const high = blockEnergy(zeroPhaseFilter(samples, HIGH_BANDPASS), PEAK_BLOCK)
  const levels = high.map(power => 10 * Math.log10(Math.max(power, 1e-24)))
  const reference = quantile(active, 0.8)
  const step = PEAK_BLOCK / SAMPLE_RATE
  const pulses = []
  for (const peak of separatedPeaks(levels)) {
    const seconds = (peak + 0.5) * step
    if (seconds < 0.5 || seconds > overall.length * step - 0.5)
      continue
    const relative = 10 * Math.log10(Math.max(high[peak] / reference, 1e-24))
    const share = 10 * Math.log10(Math.max(high[peak] / Math.max(overall[peak], 1e-24), 1e-24))
    if (relative < -14 || share < -12)
      continue
    const { prominence, width } = assessPeak(levels, peak)
    if (prominence >= 5.5 && width >= 0.5 && width <= 4.2)
      pulses.push({ seconds, relative, prominence })
  }

  const groups = []
  for (let start = 0; start + 2 < pulses.length; start++) {
    let end = start + 1
    while (end < pulses.length && pulses[end].seconds - pulses[start].seconds <= 0.24) end++
    if (end - start < 3)
      continue
    const window = pulses.slice(start, end)
    groups.push({
      start: window[0].seconds,
      end: window.at(-1).seconds,
      size: window.length,
      prominence: quantile(window.map(pulse => pulse.prominence), 0.5),
      relative: quantile(window.map(pulse => pulse.relative), 0.5),
    })
  }
  groups.sort((a, b) => b.size - a.size || b.prominence - a.prominence || b.relative - a.relative)
  const selected = []
  for (const group of groups) {
    if (selected.every(item => group.end < item.start || group.start > item.end))
      selected.push(group)
  }
  return selected
}

function hasLowBandRise(samples, events) {
  const energies = blockEnergy(zeroPhaseFilter(samples, LOW_BANDPASS), LOW_BLOCK)
  function median(start, end) {
    const first = Math.max(0, Math.ceil(start * 100 - 0.5))
    const last = Math.ceil(end * 100 - 0.5)
    const window = energies.slice(first, last)
    return window.length ? quantile(window, 0.5) : 0
  }
  return events.some(({ start, end }) => {
    const reference = Math.max(median(start - 0.18, start - 0.035), median(end + 0.035, end + 0.18))
    const power = median(start, end)
    return reference > 0 && power > 0 && 10 * Math.log10(power / reference) >= 12
  })
}

// Group both supplemental observations under one reason. The approved
// evidence establishes a strong local disturbance, without identifying its type.
export function checkLocalInterference(samples, frames, edge) {
  const candidates = localFrames(frames)
  if (groupEvents(candidates, frames, edge, STRICT_TOP_DB).length)
    return 'interference_transient'
  const events = groupEvents(candidates, frames, edge, MIN_TOP_DB)
  if (!events.length)
    return null

  const clusters = peakClusters(samples)
  if (events.some(event => clusters.some(cluster => event.start - 0.12 <= cluster.end && cluster.start <= event.end + 0.08)))
    return 'interference_local'
  const strongEvents = events.filter(event => event.peakRelativeTopDb >= -13)
  return strongEvents.length && hasLowBandRise(samples, strongEvents) ? 'interference_local' : null
}
