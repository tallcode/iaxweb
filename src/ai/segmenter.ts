import { decodeMuLaw, rmsOfPcm, SAMPLE_RATE } from './mulaw.js'

export interface ClosedSegment {
  durationMs: number
  payloads: Uint8Array[]
  voicedMs: number
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

// Audio frame layout published by iaxmon (see public/audio-player.js):
// 10-byte header (byte 0 version, byte 1 type, bytes 6..9 big-endian uint32
// media timestamp in ms) followed by PCMU payload.
const FRAME_HEADER_LENGTH = 10
const FRAME_MIN_LENGTH = 11
const FRAME_VERSION = 1
const FRAME_TYPE = 1

// Keep a short tail of recent frames so the voice attack is not lost when the
// speaking state event trails the first audio frames.
const PRE_ROLL_MS = 500
const PRE_ROLL_FRAMES = 64

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

export class NodeSegmenter {
  private readonly options: SegmenterOptions
  private readonly now: () => number
  private preRoll: Array<{ at: number, frame: Frame }> = []
  private recording: Frame[] | null = null
  private lastTimestamp: number | null = null
  private lastActivityAt: number | null = null

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
    if (this.lastTimestamp !== null && signedDifference(timestamp, this.lastTimestamp) < BACKWARD_JUMP_MS) {
      // The media clock restarted; the partial segment cannot be stitched
      // together with what follows.
      this.discardRecording('reset')
      this.preRoll = []
    }
    this.lastTimestamp = timestamp

    const payload = data.subarray(FRAME_HEADER_LENGTH)
    const frame = decodeFrame(payload)

    if (this.recording) {
      this.recording.push(frame)
      if (segmentDuration(this.recording) >= this.options.maxMs)
        this.splitAtBoundary()
    }
    this.preRoll.push({ at: timestamp, frame })
    if (this.preRoll.length > PRE_ROLL_FRAMES)
      this.preRoll.shift()
  }

  // Transmission start, announced by iaxmon's `start` event before the first
  // voiced frame. State snapshots with speaking=true also use this path when
  // the gateway joins a transmission already in progress.
  start(): void {
    if (!this.recording)
      this.recording = this.seedFromPreRoll()
  }

  // Transmission end, announced by iaxmon's `stop` event after hang_ms of
  // silence. durationMs is iaxmon's authoritative transmission length (first
  // to last voiced frame, including gaps); it is preferred over the frame
  // byte count for the minimum-length rule.
  stop(durationMs?: number): void {
    if (!this.recording)
      return
    const frames = this.recording
    this.recording = null
    // A key-up without any audio frames (e.g. a PTT blip) is dropped
    // silently instead of being logged as a discarded segment.
    if (frames.length > 0)
      this.emitSegment(frames, durationMs)
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
    this.preRoll = []
    this.lastTimestamp = null
  }

  private discardRecording(reason: 'offline' | 'reset'): void {
    if (!this.recording || this.recording.length === 0) {
      this.recording = null
      return
    }
    const durationMs = segmentDuration(this.recording)
    this.recording = null
    this.options.onDiscard?.(reason, durationMs)
  }

  private seedFromPreRoll(): Frame[] {
    if (this.lastTimestamp === null)
      return []
    const latest = this.lastTimestamp
    return this.preRoll
      .filter(entry => latest >= entry.at && latest - entry.at <= PRE_ROLL_MS)
      .map(entry => entry.frame)
  }

  private splitAtBoundary(): void {
    const frames = this.recording
    if (!frames)
      return
    const cutIndex = findCutIndex(frames, this.options.maxMs, Math.min(this.options.coldMinMs, this.options.hotMinMs))
    const chunk = frames.slice(0, cutIndex)
    this.recording = frames.slice(cutIndex)
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
      })
    }
    // Only a transmission long enough to count as real activity (cold
    // minimum) keeps the node hot for the next one; discarded noise bursts
    // must not switch it into hot start.
    if (totalMs >= this.options.coldMinMs)
      this.lastActivityAt = this.now()
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
