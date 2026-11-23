import type { Frame, TimedFrame } from './segment-audio.js'
import { randomUUID } from 'node:crypto'
import { parseAudioFrame, signedMediaTimestampDifference } from '@iaxweb/audio-protocol'
import { decodeFrame, insertTimedFrame, renderTimeline, SAMPLES_PER_MS, segmentDuration, sliceFrame, splitTimeline, trimSilence, voicedDuration } from './segment-audio.js'

export { findCutIndex, VOICE_DBFS_THRESHOLD } from './segment-audio.js'

export interface ClosedSegment {
  capturedAt: string
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

// The browser player resets its timeline on backward jumps beyond 1 s.
const BACKWARD_JUMP_MS = -1_000

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
    const audio = parseAudioFrame(data)
    if (!audio)
      return
    const { payload, timestamp } = audio
    const frame = decodeFrame(payload.slice(), this.now())
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
      ? signedMediaTimestampDifference(timestamp, this.originTimestamp) * SAMPLES_PER_MS
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
    if (this.startTimestamp !== undefined && signedMediaTimestampDifference(timestamp, this.startTimestamp) < 0)
      return
    const frames = this.recording
    if (!frames)
      return
    this.originTimestamp ??= timestamp
    let at = signedMediaTimestampDifference(timestamp, this.originTimestamp) * SAMPLES_PER_MS
    if (at + frame.payload.length <= this.emittedThrough)
      return
    // An explicit start establishes the clock epoch, so earlier frames inside
    // that transmission are reordered, not mistaken for a clock reset.
    if (this.startTimestamp === undefined && this.lastTimestamp !== null
      && signedMediaTimestampDifference(timestamp, this.lastTimestamp) < BACKWARD_JUMP_MS
      && !frames.some(entry => entry.at === at)) {
      this.discardRecording('reset')
      this.clearPending()
      this.bufferFrame(timestamp, frame)
      return
    }
    if (this.lastTimestamp === null || signedMediaTimestampDifference(timestamp, this.lastTimestamp) > 0)
      this.lastTimestamp = timestamp
    if (at < this.emittedThrough) {
      frame = sliceFrame(frame, this.emittedThrough - at)
      at = this.emittedThrough
    }
    if (!insertTimedFrame(frames, frame, at))
      return
    this.recordingEnd = Math.max(this.recordingEnd, at + frame.payload.length)
    while (this.recording && this.recording.length > 0
      && this.recordingEnd - this.recording[0]!.at >= this.options.maxMs * SAMPLES_PER_MS) {
      this.splitAtBoundary()
    }
  }

  private splitAtBoundary(): void {
    const frames = this.recording
    if (!frames)
      return
    const split = splitTimeline(frames, this.options.maxMs, Math.min(this.options.coldMinMs, this.options.hotMinMs))
    if (!split)
      return
    const { chunk, cutAt, remaining } = split
    this.emittedThrough = cutAt
    this.recording = remaining
    this.recordingEnd = remaining.reduce((end, frame) => Math.max(end, frame.at + frame.payload.length), cutAt)
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
        capturedAt: new Date(trimmed[0]!.receivedAt ?? this.now()).toISOString(),
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
