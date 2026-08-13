import type { ClosedSegment, DiscardReason } from '../../src/ai/segmenter.js'
import assert from 'node:assert/strict'

import test from 'node:test'
import { NodeSegmenter } from '../../src/ai/segmenter.js'

const FRAME_SAMPLES = 160 // 20 ms at 8 kHz
const VOICE = 0x80 // decodes to ~0.98 amplitude
const LOW_VOICE = 0xF8 // decodes to ~-55 dBFS: below the voice gate, above trim
const SILENCE = 0xFF // decodes to 0

function makeFrame(fill: number, timestampMs: number, samples: number = FRAME_SAMPLES): Uint8Array {
  const frame = new Uint8Array(10 + samples)
  frame[0] = 1
  frame[1] = 1
  new DataView(frame.buffer).setUint32(6, timestampMs >>> 0, false)
  frame.fill(fill, 10)
  return frame
}

interface Capture {
  discards: Array<{ durationMs: number, minMs?: number, reason: DiscardReason }>
  segments: ClosedSegment[]
}

interface SegmenterTestOptions {
  activityWindowMs?: number
  coldMinMs?: number
  hotMinMs?: number
  maxMs?: number
  now?: () => number
}

function makeSegmenter(options: SegmenterTestOptions = {}): { capture: Capture, segmenter: NodeSegmenter } {
  const capture: Capture = { discards: [], segments: [] }
  const segmenter = new NodeSegmenter({
    activityWindowMs: options.activityWindowMs ?? 30_000,
    coldMinMs: options.coldMinMs ?? 5_000,
    hotMinMs: options.hotMinMs ?? options.coldMinMs ?? 5_000,
    maxMs: options.maxMs ?? 120_000,
    ...(options.now ? { now: options.now } : {}),
    onDiscard: (reason, durationMs, minMs) => {
      capture.discards.push({ durationMs, reason, ...(minMs !== undefined ? { minMs } : {}) })
    },
    onSegment: segment => capture.segments.push(segment),
  })
  return { capture, segmenter }
}

function pushVoice(segmenter: NodeSegmenter, frames: number, startTimestampMs: number, fill: number = VOICE): void {
  for (let index = 0; index < frames; index++)
    segmenter.pushFrame(makeFrame(fill, startTimestampMs + index * 20))
}

test('produces a segment for a transmission over the minimum', () => {
  const { capture, segmenter } = makeSegmenter()
  segmenter.setSpeaking(true)
  pushVoice(segmenter, 300, 0) // 6 s
  segmenter.setSpeaking(false)

  assert.equal(capture.discards.length, 0)
  const segment = capture.segments[0]
  assert.ok(segment)
  assert.equal(segment.durationMs, 6_000)
  assert.equal(segment.voicedMs, 6_000)
  assert.equal(segment.payloads.length, 300)
})

test('discards transmissions with voiced audio below the minimum', () => {
  const { capture, segmenter } = makeSegmenter()
  segmenter.setSpeaking(true)
  pushVoice(segmenter, 200, 0) // 4 s
  segmenter.setSpeaking(false)

  assert.equal(capture.segments.length, 0)
  assert.deepEqual(capture.discards, [{ durationMs: 4_000, minMs: 5_000, reason: 'short' }])
})

test('keeps quiet transmissions when the duration is long enough', () => {
  // The energy gate trims edges; it must not veto the minimum-length rule,
  // because radio audio levels vary a lot.
  const { capture, segmenter } = makeSegmenter()
  segmenter.start()
  pushVoice(segmenter, 300, 0, LOW_VOICE) // 6 s at -72 dBFS
  segmenter.stop(6_000)

  assert.equal(capture.discards.length, 0)
  const segment = capture.segments[0]
  assert.ok(segment)
})

test('discards empty carriers without voiced audio', () => {
  const { capture, segmenter } = makeSegmenter()
  segmenter.setSpeaking(true)
  pushVoice(segmenter, 500, 0, SILENCE) // 10 s of silence
  segmenter.setSpeaking(false)

  assert.equal(capture.segments.length, 0)
  assert.deepEqual(capture.discards, [{ durationMs: 10_000, minMs: 5_000, reason: 'short' }])
})

test('trims silence from segment edges', () => {
  const { capture, segmenter } = makeSegmenter()
  segmenter.setSpeaking(true)
  pushVoice(segmenter, 50, 0, SILENCE) // 1 s leading silence
  pushVoice(segmenter, 300, 1_000) // 6 s voice
  pushVoice(segmenter, 50, 7_000, SILENCE) // 1 s trailing silence
  segmenter.setSpeaking(false)

  const segment = capture.segments[0]
  assert.ok(segment)
  assert.equal(segment.durationMs, 6_000)
  assert.equal(segment.voicedMs, 6_000)
})

test('records a transmission delimited by start and stop events', () => {
  const { capture, segmenter } = makeSegmenter()
  segmenter.start()
  pushVoice(segmenter, 300, 0) // 6 s
  segmenter.stop(6_000)

  assert.equal(capture.discards.length, 0)
  const segment = capture.segments[0]
  assert.ok(segment)
  assert.equal(segment.durationMs, 6_000)
})

test('prefers the reported stop duration for the minimum rule', () => {
  const { capture, segmenter } = makeSegmenter()
  segmenter.start()
  pushVoice(segmenter, 300, 0)
  // iaxmon reports a shorter authoritative duration than the frames suggest.
  segmenter.stop(3_000)

  assert.equal(capture.segments.length, 0)
  assert.deepEqual(capture.discards, [{ durationMs: 3_000, minMs: 5_000, reason: 'short' }])
})

test('only transmissions of cold length keep the node hot', () => {
  let time = 0
  const { capture, segmenter } = makeSegmenter({ coldMinMs: 5_000, hotMinMs: 2_000, now: () => time })

  // A discarded 4 s burst does not count as activity...
  segmenter.start()
  pushVoice(segmenter, 200, 0) // 4 s
  segmenter.stop(4_000)
  assert.deepEqual(capture.discards, [{ durationMs: 4_000, minMs: 5_000, reason: 'short' }])

  // ...so 10 s later the node is still cold and a 2.5 s turn is discarded.
  time += 10_000
  segmenter.start()
  pushVoice(segmenter, 125, 100_000) // 2.5 s
  segmenter.stop(2_500)
  assert.deepEqual(capture.discards.at(-1), { durationMs: 2_500, minMs: 5_000, reason: 'short' })

  // A 6 s transmission is kept and counts as activity.
  time += 10_000
  segmenter.start()
  pushVoice(segmenter, 300, 200_000) // 6 s
  segmenter.stop(6_000)
  assert.equal(capture.segments.length, 1)

  // 10 s later a 2.5 s reply uses the hot minimum and is kept.
  time += 10_000
  segmenter.start()
  pushVoice(segmenter, 125, 300_000) // 2.5 s
  segmenter.stop(2_500)
  assert.equal(capture.segments.length, 2)

  // After 31 s of silence the node is cold again; the hot-kept 2.5 s reply
  // did not extend the activity window.
  time += 31_000
  segmenter.start()
  pushVoice(segmenter, 150, 400_000) // 3 s
  segmenter.stop(3_000)
  assert.deepEqual(capture.discards.at(-1), { durationMs: 3_000, minMs: 5_000, reason: 'short' })
})

test('stop without a start is ignored', () => {
  const { capture, segmenter } = makeSegmenter()
  segmenter.stop(6_000)
  assert.equal(capture.segments.length, 0)
  assert.equal(capture.discards.length, 0)
})

test('splits overlong transmissions at the maximum length', () => {
  const { capture, segmenter } = makeSegmenter({ coldMinMs: 400, hotMinMs: 400, maxMs: 3_000 })
  segmenter.setSpeaking(true)
  pushVoice(segmenter, 350, 0) // 7 s of continuous voice
  segmenter.setSpeaking(false)

  assert.deepEqual(
    capture.segments.map(segment => segment.durationMs),
    [3_000, 3_000, 1_000],
  )
  assert.equal(capture.discards.length, 0)
})

test('splits overlong transmissions at a quiet window when available', () => {
  const { capture, segmenter } = makeSegmenter({ coldMinMs: 400, hotMinMs: 400, maxMs: 3_000 })
  segmenter.setSpeaking(true)
  pushVoice(segmenter, 125, 0) // 2.5 s voice
  pushVoice(segmenter, 15, 2_500, SILENCE) // 0.3 s pause
  pushVoice(segmenter, 210, 2_800) // voice to 7 s total
  segmenter.setSpeaking(false)

  const durations = capture.segments.map(segment => segment.durationMs)
  // The first chunk is cut at the pause instead of running to maxMs; the
  // 300 ms pause then lands at the head of the next chunk and gets trimmed.
  assert.equal(durations[0], 2_500)
  assert.equal(durations.reduce((sum, ms) => sum + ms, 0), 6_700)
  for (const durationMs of durations)
    assert.ok(durationMs <= 3_000)
})

test('includes recent pre-roll audio when speaking starts', () => {
  const { capture, segmenter } = makeSegmenter()
  pushVoice(segmenter, 30, 0) // 600 ms of audio before the speaking event
  segmenter.setSpeaking(true)
  pushVoice(segmenter, 275, 600) // 5.5 s
  segmenter.setSpeaking(false)

  const segment = capture.segments[0]
  assert.ok(segment)
  // Up to 500 ms of pre-roll joins the 5.5 s transmission.
  assert.ok(segment.durationMs >= 5_900 && segment.durationMs <= 6_100, `got ${segment.durationMs}`)
})

test('drops the partial segment when the media clock jumps backwards', () => {
  const { capture, segmenter } = makeSegmenter()
  segmenter.setSpeaking(true)
  pushVoice(segmenter, 100, 100_000) // 2 s
  segmenter.pushFrame(makeFrame(VOICE, 5_000)) // backward jump
  assert.equal(segmenter.isRecording, false)
  assert.deepEqual(capture.discards, [{ durationMs: 2_000, reason: 'reset' }])
})

test('drops the partial segment when the node goes offline', () => {
  const { capture, segmenter } = makeSegmenter()
  segmenter.setSpeaking(true)
  pushVoice(segmenter, 150, 0) // 3 s
  segmenter.reset()

  assert.equal(segmenter.isRecording, false)
  assert.deepEqual(capture.discards, [{ durationMs: 3_000, reason: 'offline' }])
})

test('ignores frames with an unknown header', () => {
  const { capture, segmenter } = makeSegmenter()
  segmenter.setSpeaking(true)
  const bad = makeFrame(VOICE, 0)
  bad[0] = 9
  segmenter.pushFrame(bad)
  segmenter.pushFrame(new Uint8Array(5))
  segmenter.setSpeaking(false)

  assert.equal(capture.segments.length, 0)
  assert.equal(capture.discards.length, 0)
})

test('does not start recording before the first frame', () => {
  const { capture, segmenter } = makeSegmenter()
  segmenter.setSpeaking(true)
  segmenter.setSpeaking(false)
  assert.equal(capture.segments.length, 0)
  assert.equal(capture.discards.length, 0)
})
