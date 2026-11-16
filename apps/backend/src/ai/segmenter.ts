import { randomUUID } from 'node:crypto'
import { decodeMuLaw, rmsOfPcm, SAMPLE_RATE } from './mulaw.js'

export interface ClosedSegment {
  durationMs: number
  payloads: Uint8Array[]
  voicedMs: number
  transmissionId?: string | undefined
  partIndex?: number | undefined
}

export type DiscardReason = 'offline' | 'reset' | 'short'

export interface SegmenterOptions {
  // A transmission within this window after the previous one keeps the node
  // "hot" (conversation in progress) and lowers the minimum length.
  activityWindowMs: number
  coldMinMs: number
  hotMinMs: number
  maxMs: number
  now?: () => number
  onSegment: (segment: ClosedSegment) => void
  onDiscard?: (reason: DiscardReason, durationMs: number, minMs?: number) => void
}

// Frames below this level are treated as silence for trimming and voiced
// duration. Radio audio is narrowband and noisy; keep the gate low.
export const VOICE_DBFS_THRESHOLD = -50
// Edge trimming uses a lower bar than the voice statistic so quiet but real
// audio is kept.
const TRIM_DBFS_THRESHOLD = -60

// Audio frame layout published by iaxmon (see public/index/audio-player.js):
// 10-byte header (byte 0 version, byte 1 type, bytes 6..9 big-endian uint32
// media timestamp in ms) followed by PCMU payload.
const FRAME_HEADER_LENGTH = 10
const FRAME_MIN_LENGTH = 11
const FRAME_VERSION = 1
const FRAME_TYPE = 1

// Reconstructed PCMU silence uses the same 20 ms cadence as iaxmon.
const SILENCE_FRAME_SAMPLES = 160
const SAMPLES_PER_MS = SAMPLE_RATE / 1000

// The browser player resets its timeline on backward jumps beyond 1 s.
const BACKWARD_JUMP_MS = -1_000

// When a segment exceeds maxMs, look for the quietest 100 ms window within
// the final 10 s to avoid cutting through a word.
const CUT_SEARCH_MS = 10_000
const CUT_WINDOW_MS = 100

const voiceRmsThreshold = 10 ** (VOICE_DBFS_THRESHOLD / 20)
const trimRmsThreshold = 10 ** (TRIM_DBFS_THRESHOLD / 20)

interface Frame {
  ms: number
  payload: Uint8Array
  rms: number
}

interface TimedFrame extends Frame {
  // Sample offset relative to this transmission's media clock origin.
  at: number
}

interface PendingFrame {
  timestamp: number
  receivedAt: number
  frame: Frame
}

export class NodeSegmenter {
  private readonly options: SegmenterOptions
  private readonly now: () => number
  // Only unclaimed audio (for a gateway joining mid-transmission) lives here.
  // Recorded frames must never be replayed into a subsequent transmission.
  private pendingFrames: PendingFrame[] = []
  private pendingSamples = 0
  private recording: TimedFrame[] | null = null
  private originTimestamp: number | null = null
  private startTimestamp: number | undefined
  private recordingEnd = 0
  private emittedThrough = Number.NEGATIVE_INFINITY
  private lastTimestamp: number | null = null
  private lastActivityAt: number | null = null
  private transmissionId: string | undefined
  private partIndex = 0

  constructor(options: SegmenterOptions) {
    this.options = options
    this.now = options.now ?? Date.now
  }

  get isRecording(): boolean {
    return this.recording !== null
  }

  pushFrame(data: Uint8Array): void {
    if (data.length < FRAME_MIN_LENGTH || data[0] !== FRAME_VERSION || data[1] !== FRAME_TYPE)
      return

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const timestamp = view.getUint32(6, false)
    const frame = decodeFrame(data.slice(FRAME_HEADER_LENGTH))
    if (this.recording)
      this.recordFrame(timestamp, frame)
    else
      this.bufferFrame(timestamp, frame)
  }

  // iaxmon announces the media timestamp of the first voiced frame. A state
  // snapshot has no timestamp and claims audio received since the last stop.
  start(timestamp?: number): void {
    if (this.recording)
      return
    const pending = this.pendingFrames
    this.clearPending()
    this.transmissionId = randomUUID()
    this.partIndex = 0
    this.originTimestamp = timestamp ?? null
    this.startTimestamp = timestamp
    this.lastTimestamp = null
    this.recordingEnd = 0
    this.emittedThrough = Number.NEGATIVE_INFINITY
    this.recording = []
    for (const entry of pending) {
      if (this.now() - entry.receivedAt <= this.options.maxMs)
        this.recordFrame(entry.timestamp, entry.frame)
    }
  }

  // Transmission end, announced by iaxmon's `stop` event after hang_ms of
  // silence. durationMs is iaxmon's authoritative transmission length (first
  // to last voiced frame, including gaps); it is preferred over the frame
  // byte count for the minimum-length rule.
  stop(durationMs?: number, timestamp?: number): void {
    // A gateway can join after start and receive stop before its snapshot.
    // Those buffered frames still belong to the transmission being closed.
    if (!this.recording && this.pendingFrames.length > 0
      && (durationMs !== undefined || timestamp !== undefined)) {
      this.start()
    }
    this.clearPending()
    if (!this.recording)
      return
    const end = timestamp !== undefined && this.originTimestamp !== null
      ? signedDifference(timestamp, this.originTimestamp) * SAMPLES_PER_MS
      : Number.POSITIVE_INFINITY
    // Normal stops point to a suppressed silent frame. On disconnect iaxmon
    // may instead point to the final audio frame; that whole frame belongs here.
    const frames = renderTimeline(this.recording.filter(frame => frame.at <= end))
    this.recording = null
    this.lastTimestamp = null
    this.originTimestamp = null
    this.startTimestamp = undefined
    // A key-up without any audio frames (e.g. a PTT blip) is dropped
    // silently instead of being logged as a discarded segment.
    if (frames.length > 0)
      this.emitSegment(frames, durationMs)
    this.transmissionId = undefined
    this.partIndex = 0
  }

  // Speaking field of a state event. Primary transmission boundaries are the
  // start/stop events; this only synchronizes state snapshots (for example a
  // gateway connecting mid-transmission).
  setSpeaking(speaking: boolean): void {
    if (speaking)
      this.start()
    else
      this.stop()
  }

  // Called when the node goes offline (e.g. NATS disconnect).
  reset(): void {
    this.discardRecording('offline')
    this.clearPending()
    this.lastTimestamp = null
  }

  private discardRecording(reason: 'offline' | 'reset'): void {
    this.transmissionId = undefined
    this.partIndex = 0
    if (!this.recording || this.recording.length === 0) {
      this.recording = null
      return
    }
    const durationMs = segmentDuration(renderTimeline(this.recording))
    this.recording = null
    this.options.onDiscard?.(reason, durationMs)
  }

  private clearPending(): void {
    this.pendingFrames = []
    this.pendingSamples = 0
  }

  private bufferFrame(timestamp: number, frame: Frame): void {
    const receivedAt = this.now()
    this.pendingFrames.push({ timestamp, frame, receivedAt })
    this.pendingSamples += frame.payload.length
    // Snapshot requests may take longer than 500 ms. Retain unclaimed audio
    // up to the normal segment limit, with both a sample and an age bound.
    while (this.pendingFrames.length > 0
      && (this.pendingSamples > this.options.maxMs * SAMPLES_PER_MS
        || receivedAt - this.pendingFrames[0]!.receivedAt > this.options.maxMs)) {
      this.pendingSamples -= this.pendingFrames.shift()!.frame.payload.length
    }
  }

  private recordFrame(timestamp: number, frame: Frame): void {
    if (this.startTimestamp !== undefined && signedDifference(timestamp, this.startTimestamp) < 0)
      return
    const frames = this.recording
    if (!frames)
      return
    this.originTimestamp ??= timestamp
    let at = signedDifference(timestamp, this.originTimestamp) * SAMPLES_PER_MS
    if (at + frame.payload.length <= this.emittedThrough)
      return
    // An explicit start establishes the clock epoch, so earlier frames inside
    // that transmission are reordered, not mistaken for a clock reset.
    if (this.startTimestamp === undefined && this.lastTimestamp !== null
      && signedDifference(timestamp, this.lastTimestamp) < BACKWARD_JUMP_MS
      && !frames.some(entry => entry.at === at)) {
      this.discardRecording('reset')
      this.clearPending()
      this.bufferFrame(timestamp, frame)
      return
    }
    if (this.lastTimestamp === null || signedDifference(timestamp, this.lastTimestamp) > 0)
      this.lastTimestamp = timestamp
    if (at < this.emittedThrough) {
      frame = decodeFrame(frame.payload.subarray(this.emittedThrough - at))
      at = this.emittedThrough
    }
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
          return
        frames[index] = timed
      }
      else {
        frames.splice(index, 0, timed)
      }
    }
    this.recordingEnd = Math.max(this.recordingEnd, at + frame.payload.length)
    while (this.recording && this.recording.length > 0
      && this.recordingEnd - this.recording[0]!.at >= this.options.maxMs * SAMPLES_PER_MS) {
      this.splitAtBoundary()
    }
  }

  private splitAtBoundary(): void {
    const frames = this.recording
    const first = frames?.[0]
    if (!frames || !first)
      return
    // Bound reconstruction even if a corrupt timestamp jumps far forward.
    const timeline = renderTimeline(frames, first.at + this.options.maxMs * SAMPLES_PER_MS)
    const cutIndex = findCutIndex(timeline, this.options.maxMs, Math.min(this.options.coldMinMs, this.options.hotMinMs))
    const chunk = timeline.slice(0, cutIndex)
    const cutAt = first.at + chunk.reduce((samples, frame) => samples + frame.payload.length, 0)
    this.emittedThrough = cutAt
    this.recording = frames.flatMap((frame) => {
      if (frame.at + frame.payload.length <= cutAt)
        return []
      if (frame.at >= cutAt)
        return [frame]
      return [{ ...decodeFrame(frame.payload.subarray(cutAt - frame.at)), at: cutAt }]
    })
    this.recordingEnd = this.recording.reduce((end, frame) => Math.max(end, frame.at + frame.payload.length), cutAt)
    if (chunk.length > 0)
      this.emitSegment(chunk)
  }

  private emitSegment(frames: Frame[], reportedDurationMs?: number): void {
    const totalMs = reportedDurationMs ?? segmentDuration(frames)
    const minMs = this.currentMinMs()
    const trimmed = trimSilence(frames)
    if (trimmed.length === 0 || totalMs < minMs) {
      this.options.onDiscard?.('short', totalMs, minMs)
    }
    else {
      this.options.onSegment({
        durationMs: segmentDuration(trimmed),
        payloads: trimmed.map(frame => frame.payload),
        voicedMs: voicedDuration(trimmed),
        transmissionId: this.transmissionId,
        partIndex: this.partIndex,
      })
    }
    // Only a transmission long enough to count as real activity (cold
    // minimum) keeps the node hot for the next one; discarded noise bursts
    // must not switch it into hot start.
    if (totalMs >= this.options.coldMinMs)
      this.lastActivityAt = this.now()
    // Count discarded chunks too, so missing audio can never be stitched as
    // if it were adjacent to a later chunk.
    this.partIndex++
  }

  // Cold start (no recent activity, typically a first CQ call) uses the
  // higher minimum; an active conversation accepts shorter turns.
  private currentMinMs(): number {
    if (this.lastActivityAt !== null && this.now() - this.lastActivityAt <= this.options.activityWindowMs)
      return this.options.hotMinMs
    return this.options.coldMinMs
  }
}

function decodeFrame(payload: Uint8Array): Frame {
  return {
    ms: (payload.length * 1000) / SAMPLE_RATE,
    payload,
    rms: rmsOfPcm(decodeMuLaw(payload)),
  }
}

// Preserve media-clock gaps inside a transmission. Sort on insertion and
// merge overlapping sample ranges so late/duplicate frames cannot replay audio.
// No silence is added before the first frame or after the last voiced frame.
function renderTimeline(frames: TimedFrame[], end = Number.POSITIVE_INFINITY): Frame[] {
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
      : decodeFrame(frame.payload.subarray(skip, skip + samples)))
    cursor += samples
  }
  return result
}

function segmentDuration(frames: Frame[]): number {
  let ms = 0
  for (const frame of frames)
    ms += frame.ms
  return ms
}

function voicedDuration(frames: Frame[]): number {
  let ms = 0
  for (const frame of frames) {
    if (frame.rms >= voiceRmsThreshold)
      ms += frame.ms
  }
  return ms
}

function trimSilence(frames: Frame[]): Frame[] {
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

function signedDifference(current: number, previous: number): number {
  return (current - previous) | 0
}
