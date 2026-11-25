import type { ClosedSegment, DiscardReason } from '../../src/ai/segmenter.js'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'

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
  getSourceRepeaterId?: () => string | null
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
    ...(options.getSourceRepeaterId ? { getSourceRepeaterId: options.getSourceRepeaterId } : {}),
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
  let now = Date.parse('2026-11-22T23:59:58.000Z')
  const { capture, segmenter } = makeSegmenter({ now: () => now })
  segmenter.setSpeaking(true)
  pushVoice(segmenter, 300, 0) // 6 s
  now += 6_000
  segmenter.setSpeaking(false)

  assert.equal(capture.discards.length, 0)
  const segment = capture.segments[0]
  assert.ok(segment)
  assert.equal(segment.capturedAt, '2026-11-22T23:59:58.000Z')
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
  pushVoice(segmenter, 300, 0, LOW_VOICE) // 6 s at approximately -55 dBFS
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
  const ids = capture.segments.map(segment => segment.transmissionId)
  assert.ok(ids[0])
  assert.ok(ids.every(id => id === ids[0]))
  assert.deepEqual(capture.segments.map(segment => segment.partIndex), [0, 1, 2])
})

test('a later transmission does not inherit the previous chunk identity', () => {
  const { capture, segmenter } = makeSegmenter({ coldMinMs: 400, hotMinMs: 400 })
  segmenter.start()
  pushVoice(segmenter, 30, 0)
  segmenter.stop()
  segmenter.start()
  pushVoice(segmenter, 30, 1_000)
  segmenter.stop()
  assert.notEqual(capture.segments[0]?.transmissionId, capture.segments[1]?.transmissionId)
  assert.deepEqual(capture.segments.map(segment => segment.partIndex), [0, 0])
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

test('keeps all unclaimed audio while waiting for a speaking snapshot', () => {
  const { capture, segmenter } = makeSegmenter()
  pushVoice(segmenter, 30, 0) // 600 ms of audio before the speaking event
  segmenter.setSpeaking(true)
  pushVoice(segmenter, 275, 600) // 5.5 s
  segmenter.setSpeaking(false)

  const segment = capture.segments[0]
  assert.ok(segment)
  assert.equal(segment.durationMs, 6_100)
})

test('attributes a segment at 70 percent even if its midpoint source was unknown', () => {
  let source: string | null = '1901'
  const { capture, segmenter } = makeSegmenter({ coldMinMs: 1, getSourceRepeaterId: () => source })
  pushVoice(segmenter, 4, 1_000)
  source = null
  pushVoice(segmenter, 3, 1_080)
  segmenter.start(1_000)
  source = '1901'
  pushVoice(segmenter, 3, 1_140)
  source = '1902'
  segmenter.stop(200, 1_680)

  assert.equal(capture.segments[0]?.sourceRepeaterId, '1901')
})

test('counts speech with unknown and other sources against the 70 percent threshold', () => {
  let source: string | null = '1901'
  const { capture, segmenter } = makeSegmenter({ coldMinMs: 1, getSourceRepeaterId: () => source })
  segmenter.start(1_000)
  pushVoice(segmenter, 69, 1_000)
  source = null
  pushVoice(segmenter, 30, 2_380)
  source = '1902'
  pushVoice(segmenter, 1, 2_980)
  segmenter.stop(2_000, 3_480)

  assert.equal(capture.segments[0]?.sourceRepeaterId, null)
})

test('preserves all audio when the source repeater lookup fails', () => {
  const { capture, segmenter } = makeSegmenter({
    coldMinMs: 1,
    getSourceRepeaterId() {
      throw new Error('Source repeater status unavailable')
    },
  })
  segmenter.start(1_000)
  pushVoice(segmenter, 3, 1_000)
  segmenter.stop(60, 1_060)

  assert.equal(capture.discards.length, 0)
  assert.equal(capture.segments.length, 1)
  const segment = capture.segments[0]!
  assert.equal(segment.sourceRepeaterId, null)
  assert.deepEqual(Buffer.concat(segment.payloads), Buffer.alloc(3 * FRAME_SAMPLES, VOICE))
})

test('weights source votes by speech duration and excludes silent gaps', () => {
  let source: string | null = null
  const { capture, segmenter } = makeSegmenter({ coldMinMs: 1, getSourceRepeaterId: () => source })
  segmenter.start(1_000)
  pushVoice(segmenter, 2, 1_000)
  source = '1901'
  segmenter.pushFrame(makeFrame(LOW_VOICE, 1_240, 5 * FRAME_SAMPLES))
  segmenter.stop(340, 1_820)

  assert.equal(capture.segments[0]?.durationMs, 340)
  assert.equal(capture.segments[0]?.sourceRepeaterId, '1901')
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

function samplesOf(segment: ClosedSegment | undefined): Buffer {
  assert.ok(segment)
  return Buffer.concat(segment.payloads)
}

test('never replays a previous transmission after a long silent interval', () => {
  let time = 0
  const { capture, segmenter } = makeSegmenter({ coldMinMs: 1, now: () => time })
  segmenter.start(0)
  pushVoice(segmenter, 30, 0)
  segmenter.stop(600, 1_080)
  time = 60_000
  segmenter.start(60_000)
  pushVoice(segmenter, 30, 60_000, LOW_VOICE)
  segmenter.stop(600, 61_080)

  assert.deepEqual(capture.segments.map(segment => segment.durationMs), [600, 600])
  assert.deepEqual(samplesOf(capture.segments[1]), Buffer.alloc(4_800, LOW_VOICE))
})

test('does not replay a discarded transmission into the next one', () => {
  const { capture, segmenter } = makeSegmenter({ coldMinMs: 400 })
  segmenter.start()
  pushVoice(segmenter, 10, 0)
  segmenter.stop(200)
  segmenter.start()
  pushVoice(segmenter, 30, 1_000, LOW_VOICE)
  segmenter.stop(600)

  assert.equal(capture.segments.length, 1)
  assert.deepEqual(samplesOf(capture.segments[0]), Buffer.alloc(4_800, LOW_VOICE))
})

test('uses the start timestamp to exclude stale unclaimed audio', () => {
  const { capture, segmenter } = makeSegmenter({ coldMinMs: 1 })
  pushVoice(segmenter, 3, 100)
  pushVoice(segmenter, 3, 1_000, LOW_VOICE)
  segmenter.start(1_000)
  pushVoice(segmenter, 2, 1_060, LOW_VOICE)
  segmenter.stop(100, 1_580)

  assert.deepEqual(samplesOf(capture.segments[0]), Buffer.alloc(800, LOW_VOICE))
})

test('expires unclaimed audio by wall time even when no new frames arrive', () => {
  let time = 0
  const { capture, segmenter } = makeSegmenter({ coldMinMs: 1, maxMs: 1_000, now: () => time })
  pushVoice(segmenter, 3, 0)
  time = 2_000
  segmenter.setSpeaking(true)
  pushVoice(segmenter, 3, 2_000, LOW_VOICE)
  segmenter.stop(60)

  assert.deepEqual(samplesOf(capture.segments[0]), Buffer.alloc(480, LOW_VOICE))
})

test('restores omitted internal silence without adding the stop hang time', () => {
  const { capture, segmenter } = makeSegmenter({ coldMinMs: 1 })
  segmenter.start(1_000)
  pushVoice(segmenter, 25, 1_000)
  // iaxmon sends no frames during this 300 ms pause.
  pushVoice(segmenter, 25, 1_800, LOW_VOICE)
  segmenter.stop(1_300, 2_780)

  const segment = capture.segments[0]
  assert.equal(segment?.durationMs, 1_300)
  assert.equal(segment?.voicedMs, 500)
  assert.deepEqual(samplesOf(segment), Buffer.concat([
    Buffer.alloc(4_000, VOICE),
    Buffer.alloc(2_400, SILENCE),
    Buffer.alloc(4_000, LOW_VOICE),
  ]))
})

test('orders late frames before reconstructing gaps and ignores duplicates', () => {
  const { capture, segmenter } = makeSegmenter({ coldMinMs: 1 })
  segmenter.start(1_000)
  segmenter.pushFrame(makeFrame(VOICE, 1_000))
  segmenter.pushFrame(makeFrame(VOICE, 1_040))
  segmenter.pushFrame(makeFrame(LOW_VOICE, 1_020))
  segmenter.pushFrame(makeFrame(VOICE, 1_040))
  segmenter.stop(60, 1_540)

  assert.equal(capture.segments[0]?.durationMs, 60)
  assert.deepEqual(samplesOf(capture.segments[0]), Buffer.concat([
    Buffer.alloc(160, VOICE),
    Buffer.alloc(160, LOW_VOICE),
    Buffer.alloc(160, VOICE),
  ]))
})

test('merges partially overlapping frames without repeating samples', () => {
  const { capture, segmenter } = makeSegmenter({ coldMinMs: 1 })
  segmenter.start(1_000)
  segmenter.pushFrame(makeFrame(VOICE, 1_000, 240))
  segmenter.pushFrame(makeFrame(LOW_VOICE, 1_020))
  segmenter.stop(40, 1_520)

  assert.equal(capture.segments[0]?.durationMs, 40)
  assert.deepEqual(samplesOf(capture.segments[0]), Buffer.concat([
    Buffer.alloc(240, VOICE),
    Buffer.alloc(80, LOW_VOICE),
  ]))
})

test('ignores frames outside the start and stop media boundaries', () => {
  const { capture, segmenter } = makeSegmenter({ coldMinMs: 1 })
  segmenter.start(1_000)
  segmenter.pushFrame(makeFrame(VOICE, 980))
  segmenter.pushFrame(makeFrame(LOW_VOICE, 1_000))
  segmenter.pushFrame(makeFrame(VOICE, 1_100))
  segmenter.stop(20, 1_080)

  assert.deepEqual(samplesOf(capture.segments[0]), Buffer.alloc(160, LOW_VOICE))
})

test('restores media-clock gaps across uint32 timestamp wraparound', () => {
  const { capture, segmenter } = makeSegmenter({ coldMinMs: 1 })
  const start = 0xFFFF_FFE0
  segmenter.start(start)
  segmenter.pushFrame(makeFrame(VOICE, start))
  segmenter.pushFrame(makeFrame(LOW_VOICE, start + 40))
  segmenter.stop(60, (start + 540) >>> 0)

  assert.equal(capture.segments[0]?.durationMs, 60)
  assert.deepEqual(samplesOf(capture.segments[0]), Buffer.concat([
    Buffer.alloc(160, VOICE),
    Buffer.alloc(160, SILENCE),
    Buffer.alloc(160, LOW_VOICE),
  ]))
})

test('accepts a new media clock at a subsequent transmission start', () => {
  const { capture, segmenter } = makeSegmenter({ coldMinMs: 1 })
  segmenter.start(100_000)
  pushVoice(segmenter, 3, 100_000)
  segmenter.stop(60, 100_540)
  segmenter.start(100)
  pushVoice(segmenter, 3, 100, LOW_VOICE)
  segmenter.stop(60, 640)

  assert.equal(capture.discards.length, 0)
  assert.deepEqual(capture.segments.map(segment => segment.durationMs), [60, 60])
})

test('splits sparse audio at reconstructed silence and keeps every voiced sample', () => {
  const { capture, segmenter } = makeSegmenter({ coldMinMs: 400, hotMinMs: 400, maxMs: 3_000 })
  segmenter.start(0)
  pushVoice(segmenter, 125, 0)
  pushVoice(segmenter, 210, 2_800, LOW_VOICE)
  segmenter.stop(7_000, 7_480)

  assert.equal(capture.segments[0]?.durationMs, 2_500)
  assert.deepEqual(Buffer.concat(capture.segments.flatMap(segment => segment.payloads)), Buffer.concat([
    Buffer.alloc(20_000, VOICE),
    Buffer.alloc(33_600, LOW_VOICE),
  ]))
  assert.ok(capture.segments.every(segment => segment.durationMs <= 3_000))
})

test('splits inside payloads at the exact limit without loss or replay', () => {
  const { capture, segmenter } = makeSegmenter({ coldMinMs: 1, maxMs: 55 })
  segmenter.start(0)
  pushVoice(segmenter, 6, 0)
  segmenter.pushFrame(makeFrame(VOICE, 0)) // Already emitted; must not reset or replay.
  segmenter.stop(120, 600)

  assert.deepEqual(capture.segments.map(segment => segment.durationMs), [55, 55, 10])
  assert.deepEqual(Buffer.concat(capture.segments.flatMap(segment => segment.payloads)), Buffer.alloc(960, VOICE))
})

test('keeps the whole final audio frame when a disconnect stop points to it', () => {
  const { capture, segmenter } = makeSegmenter({ coldMinMs: 1 })
  segmenter.start(1_000)
  segmenter.pushFrame(makeFrame(VOICE, 1_000))
  segmenter.stop(20, 1_000)

  assert.deepEqual(samplesOf(capture.segments[0]), Buffer.alloc(160, VOICE))
})

test('does not mistake a duplicate from an emitted chunk for a media reset', () => {
  const { capture, segmenter } = makeSegmenter({ coldMinMs: 1, maxMs: 3_000 })
  segmenter.start(0)
  pushVoice(segmenter, 350, 0)
  segmenter.pushFrame(makeFrame(VOICE, 20))
  segmenter.stop(7_000, 7_480)

  assert.equal(capture.discards.length, 0)
  assert.deepEqual(capture.segments.map(segment => segment.durationMs), [3_000, 3_000, 1_000])
  assert.deepEqual(Buffer.concat(capture.segments.flatMap(segment => segment.payloads)), Buffer.alloc(56_000, VOICE))
})

test('reorders older frames within an explicitly delimited transmission', () => {
  const { capture, segmenter } = makeSegmenter({ coldMinMs: 1 })
  segmenter.start(0)
  segmenter.pushFrame(makeFrame(VOICE, 0))
  segmenter.pushFrame(makeFrame(VOICE, 2_000))
  segmenter.pushFrame(makeFrame(LOW_VOICE, 20))
  segmenter.stop(2_020, 2_500)

  assert.equal(capture.discards.length, 0)
  assert.deepEqual(samplesOf(capture.segments[0]), Buffer.concat([
    Buffer.alloc(160, VOICE),
    Buffer.alloc(160, LOW_VOICE),
    Buffer.alloc(15_680, SILENCE),
    Buffer.alloc(160, VOICE),
  ]))
})
