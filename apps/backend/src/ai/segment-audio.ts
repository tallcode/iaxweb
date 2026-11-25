import { decodeMuLaw, rmsOfPcm, SAMPLE_RATE } from './mulaw.js'

// Frames below this level are treated as silence for trimming and voiced
// duration. Radio audio is narrowband and noisy; keep the gate low.
export const VOICE_DBFS_THRESHOLD = -50
// Edge trimming uses a lower bar than the voice statistic so quiet but real
// audio is kept.
const TRIM_DBFS_THRESHOLD = -60

// Reconstructed PCMU silence uses the same 20 ms cadence as iaxmon.
const SILENCE_FRAME_SAMPLES = 160
export const SAMPLES_PER_MS = SAMPLE_RATE / 1000

// When a segment exceeds maxMs, look for the quietest 100 ms window within
// the final 10 s to avoid cutting through a word.
const CUT_SEARCH_MS = 10_000
const CUT_WINDOW_MS = 100

const MIN_SOURCE_SHARE_PERCENT = 70

const voiceRmsThreshold = 10 ** (VOICE_DBFS_THRESHOLD / 20)
const trimRmsThreshold = 10 ** (TRIM_DBFS_THRESHOLD / 20)

export interface Frame {
  ms: number
  payload: Uint8Array
  receivedAt?: number | undefined
  rms: number
  sourceRepeaterId?: string | null | undefined
}

export interface TimedFrame extends Frame {
  // Sample offset relative to this transmission's media clock origin.
  at: number
}

export function insertTimedFrame(frames: TimedFrame[], frame: Frame, at: number): boolean {
  const timed = { ...frame, at }
  const last = frames.at(-1)
  if (!last || last.at < at) {
    frames.push(timed)
  }
  else {
    const index = frames.findIndex(entry => entry.at >= at)
    const existing = frames[index]
    if (existing?.at === at) {
      if (existing.payload.length >= frame.payload.length)
        return false
      frames[index] = timed
    }
    else {
      frames.splice(index, 0, timed)
    }
  }
  return true
}

export function splitTimeline(frames: TimedFrame[], maxMs: number, minMs: number) {
  const first = frames[0]
  if (!first)
    return undefined
  // Bound reconstruction even if a corrupt timestamp jumps far forward.
  const timeline = renderTimeline(frames, first.at + maxMs * SAMPLES_PER_MS)
  const cutIndex = findCutIndex(timeline, maxMs, minMs)
  const chunk = timeline.slice(0, cutIndex)
  const cutAt = first.at + chunk.reduce((samples, frame) => samples + frame.payload.length, 0)
  const remaining = frames.flatMap((frame) => {
    if (frame.at + frame.payload.length <= cutAt)
      return []
    if (frame.at >= cutAt)
      return [frame]
    return [{ ...sliceFrame(frame, cutAt - frame.at), at: cutAt }]
  })
  return { chunk, cutAt, remaining }
}

export function decodeFrame(payload: Uint8Array, receivedAt?: number, sourceRepeaterId?: string | null): Frame {
  return {
    ms: (payload.length * 1000) / SAMPLE_RATE,
    payload,
    receivedAt,
    rms: rmsOfPcm(decodeMuLaw(payload)),
    sourceRepeaterId,
  }
}

export function sliceFrame(frame: Frame, offset: number, end?: number): Frame {
  const receivedAt = frame.receivedAt === undefined ? undefined : frame.receivedAt + offset / SAMPLES_PER_MS
  return decodeFrame(frame.payload.subarray(offset, end), receivedAt, frame.sourceRepeaterId)
}

// Preserve media-clock gaps and merge overlapping sample ranges so that
// late or duplicate frames cannot replay audio.
// No silence is added before the first frame or after the last voiced frame.
export function renderTimeline(frames: TimedFrame[], end = Number.POSITIVE_INFINITY): Frame[] {
  const result: Frame[] = []
  let cursor = frames[0]?.at ?? 0
  for (const frame of frames) {
    while (cursor < Math.min(frame.at, end)) {
      const samples = Math.min(SILENCE_FRAME_SAMPLES, frame.at - cursor, end - cursor)
      if (samples <= 0)
        return result
      result.push({ ms: samples / SAMPLES_PER_MS, payload: new Uint8Array(samples).fill(0xFF), rms: 0 })
      cursor += samples
    }
    if (frame.at >= end)
      break
    const skip = Math.max(0, cursor - frame.at)
    const samples = Math.min(frame.payload.length - skip, end - cursor)
    if (samples <= 0)
      continue
    result.push(skip === 0 && samples === frame.payload.length
      ? frame
      : sliceFrame(frame, skip, skip + samples))
    cursor += samples
  }
  return result
}

export function segmentDuration(frames: Frame[]): number {
  let ms = 0
  for (const frame of frames)
    ms += frame.ms
  return ms
}

export function voicedDuration(frames: Frame[]): number {
  let ms = 0
  for (const frame of frames) {
    if (frame.rms >= voiceRmsThreshold)
      ms += frame.ms
  }
  return ms
}

export function trimSilence(frames: Frame[]): Frame[] {
  let start = 0
  let end = frames.length
  while (start < end) {
    const frame = frames[start]
    if (!frame || frame.rms >= trimRmsThreshold)
      break
    start++
  }
  while (end > start) {
    const frame = frames[end - 1]
    if (!frame || frame.rms >= trimRmsThreshold)
      break
    end--
  }
  return frames.slice(start, end)
}

// Count the audio samples retained from each frame so split frames contribute
// in proportion to their duration. Speech with an unknown source still counts
// toward the total, while silence and reconstructed gaps are excluded.
export function dominantSourceRepeaterId(frames: Frame[]): string | null {
  const samplesBySource = new Map<string, number>()
  let speechSamples = 0
  for (const frame of frames) {
    if (frame.rms < trimRmsThreshold)
      continue
    const samples = frame.payload.length
    speechSamples += samples
    const sourceId = frame.sourceRepeaterId
    if (sourceId != null)
      samplesBySource.set(sourceId, (samplesBySource.get(sourceId) ?? 0) + samples)
  }

  for (const [sourceId, samples] of samplesBySource) {
    if (samples * 100 >= speechSamples * MIN_SOURCE_SHARE_PERCENT)
      return sourceId
  }
  return null
}

// Chooses where to cut an overlong segment. Prefers the quietest 100 ms window
// inside the final CUT_SEARCH_MS (bounded so the chunk stays within
// [maxMs - CUT_SEARCH_MS, maxMs]); falls back to a hard cut at maxMs when the
// tail never goes quiet.
export function findCutIndex(frames: Frame[], maxMs: number, minMs: number): number {
  const cumulative: number[] = []
  let total = 0
  for (const frame of frames) {
    total += frame.ms
    cumulative.push(total)
  }

  let hardIndex = frames.length
  for (let index = 0; index < frames.length; index++) {
    if ((cumulative[index] ?? 0) >= maxMs) {
      hardIndex = index + 1
      break
    }
  }

  const softStartMs = Math.max(0, maxMs - CUT_SEARCH_MS)
  let bestIndex = -1
  let bestAverageRms = Number.POSITIVE_INFINITY
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index]
    if (!frame)
      break
    const startMs = index === 0 ? 0 : (cumulative[index - 1] ?? 0)
    if (startMs < softStartMs || startMs < minMs)
      continue
    if ((cumulative[index] ?? 0) > maxMs)
      break

    const windowEndMs = startMs + CUT_WINDOW_MS
    let energy = 0
    let windowMs = 0
    for (let cursor = index; cursor < frames.length; cursor++) {
      const cursorFrame = frames[cursor]
      if (!cursorFrame)
        break
      const cursorStartMs = cursor === 0 ? 0 : (cumulative[cursor - 1] ?? 0)
      if (cursorStartMs >= windowEndMs)
        break
      energy += cursorFrame.rms ** 2 * cursorFrame.ms
      windowMs += cursorFrame.ms
    }
    const averageRms = windowMs > 0 ? Math.sqrt(energy / windowMs) : 0
    if (averageRms < bestAverageRms) {
      bestAverageRms = averageRms
      bestIndex = index
    }
  }

  if (bestIndex > 0 && bestAverageRms < voiceRmsThreshold)
    return bestIndex
  return hardIndex
}
