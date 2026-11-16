import type { Msg, NatsConnection, Status, SubscriptionOptions } from '@nats-io/transport-node'
import type { ClosedSegment } from '../../src/ai/segmenter.js'
import type { AudioStateEvent } from '../../src/gateway/nats-audio.js'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { NodeSegmenter } from '../../src/ai/segmenter.js'
import { NatsAudioService } from '../../src/gateway/nats-audio.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function audio(timestamp: number, fill = 0x80): Uint8Array {
  const data = new Uint8Array(170).fill(fill, 10)
  data[0] = 1
  data[1] = 1
  new DataView(data.buffer).setUint32(6, timestamp, false)
  return data
}

function message(data: Uint8Array): Msg {
  return { data } as Msg
}

function makeGateway() {
  const subscriptions = new Map<string, SubscriptionOptions>()
  const requested = deferred<void>()
  const snapshotReply = deferred<Msg>()
  const statusEnd = deferred<IteratorResult<Status>>()
  const segments: ClosedSegment[] = []
  const states: AudioStateEvent[] = []
  const received: string[] = []
  const segmenter = new NodeSegmenter({
    activityWindowMs: 30_000,
    coldMinMs: 1,
    hotMinMs: 1,
    maxMs: 10_000,
    onSegment: segment => segments.push(segment),
  })
  const connection = {
    subscribe(subject: string, options: SubscriptionOptions) {
      // The regression was caused by using two separate async iterators.
      assert.equal(typeof options.callback, 'function')
      subscriptions.set(subject, options)
      return {}
    },
    async flush() {},
    publish() {},
    async request() {
      requested.resolve()
      return snapshotReply.promise
    },
    status: () => ({
      [Symbol.asyncIterator]: () => ({ next: () => statusEnd.promise }),
    }),
    async drain() { statusEnd.resolve({ done: true, value: undefined }) },
  } as unknown as NatsConnection
  const service = new NatsAudioService({
    config: { servers: ['nats://localhost:4222'], subjectRoot: 'iaxmon.nodes' },
    connect: async () => connection,
    nodeId: '1900',
    onAudio: (data) => {
      received.push('audio')
      segmenter.pushFrame(data)
    },
    onEvent: (text) => {
      const event = JSON.parse(text)
      received.push(event.type)
      if (event.type === 'start')
        segmenter.start(event.timestamp)
      else if (event.type === 'stop')
        segmenter.stop(event.duration_ms, event.timestamp)
    },
    onState: (state) => {
      states.push(state)
      if (state.online)
        segmenter.setSpeaking(state.speaking)
      else
        segmenter.reset()
    },
  })
  function deliver(subject: string, data: Uint8Array): void {
    const callback = subscriptions.get(`iaxmon.nodes.1900.${subject}`)?.callback
    assert.ok(callback)
    // Every callback must finish before the parser dispatches the next message.
    assert.equal(callback(null, message(data)), undefined)
  }
  return {
    service,
    segmenter,
    segments,
    states,
    received,
    async start() {
      service.start()
      await requested.promise
    },
    audio: (timestamp: number, fill?: number) => deliver('audio', audio(timestamp, fill)),
    event: (value: object) => deliver('events', new TextEncoder().encode(JSON.stringify(value))),
    async snapshot(speaking: boolean) {
      snapshotReply.resolve(message(new TextEncoder().encode(JSON.stringify({ type: 'state', online: true, speaking }))))
      await setImmediate()
    },
  }
}

test('consumes batched audio and boundaries in publisher order without mixing transmissions', async (t) => {
  const gateway = makeGateway()
  t.after(() => gateway.service.stop())
  await gateway.start()
  await gateway.snapshot(false)

  // One parser batch: no await between start, audio, stop, or the next turn.
  gateway.event({ type: 'start', timestamp: 0 })
  gateway.audio(0)
  gateway.audio(20)
  gateway.event({ type: 'stop', timestamp: 520, duration_ms: 40 })
  gateway.event({ type: 'start', timestamp: 2_000 })
  gateway.audio(2_000, 0xF8)
  gateway.audio(2_020, 0xF8)
  gateway.event({ type: 'stop', timestamp: 2_520, duration_ms: 40 })

  assert.deepEqual(gateway.received, ['start', 'audio', 'audio', 'stop', 'start', 'audio', 'audio', 'stop'])
  assert.deepEqual(gateway.segments.map(segment => segment.durationMs), [40, 40])
  assert.deepEqual(Buffer.concat(gateway.segments[0]!.payloads), Buffer.alloc(320, 0x80))
  assert.deepEqual(Buffer.concat(gateway.segments[1]!.payloads), Buffer.alloc(320, 0xF8))
})

test('ignores an idle snapshot overtaken by a live start', async (t) => {
  const gateway = makeGateway()
  t.after(() => gateway.service.stop())
  await gateway.start()
  gateway.event({ type: 'start', timestamp: 1_000 })
  gateway.audio(1_000)
  await gateway.snapshot(false)
  gateway.audio(1_020)

  assert.equal(gateway.segmenter.isRecording, true)
  assert.equal(gateway.service.currentState.online, true)
  assert.equal(gateway.service.currentState.speaking, true)
  gateway.event({ type: 'stop', timestamp: 1_520, duration_ms: 40 })
  assert.equal(gateway.segments[0]?.durationMs, 40)
})

test('ignores a speaking snapshot overtaken by a live stop', async (t) => {
  const gateway = makeGateway()
  t.after(() => gateway.service.stop())
  await gateway.start()
  gateway.event({ type: 'start', timestamp: 0 })
  gateway.audio(0)
  gateway.event({ type: 'stop', timestamp: 500, duration_ms: 20 })
  await gateway.snapshot(true)

  assert.equal(gateway.segmenter.isRecording, false)
  assert.equal(gateway.service.currentState.speaking, false)
  assert.equal(gateway.segments.length, 1)
})

test('keeps the beginning received while a mid-transmission snapshot is pending', async (t) => {
  const gateway = makeGateway()
  t.after(() => gateway.service.stop())
  await gateway.start()
  // Joined after the original start; snapshot delivery spans more than 500 ms
  // of media, so the former pre-roll window would lose the beginning.
  for (let index = 0; index < 100; index++)
    gateway.audio(1_000 + index * 20)
  await gateway.snapshot(true)
  gateway.audio(3_000, 0xF8)
  gateway.event({ type: 'stop', timestamp: 3_500, duration_ms: 4_000 })

  assert.equal(gateway.segments[0]?.durationMs, 2_020)
  assert.deepEqual(Buffer.concat(gateway.segments[0]!.payloads), Buffer.concat([
    Buffer.alloc(16_000, 0x80),
    Buffer.alloc(160, 0xF8),
  ]))
})

test('does not apply a snapshot after the gateway stops', async () => {
  const gateway = makeGateway()
  await gateway.start()
  await gateway.service.stop()
  await gateway.snapshot(true)

  assert.equal(gateway.segmenter.isRecording, false)
  assert.equal(gateway.states.length, 0)
})

test('closes audio received after joining even when stop overtakes the snapshot', async (t) => {
  const gateway = makeGateway()
  t.after(() => gateway.service.stop())
  await gateway.start()
  for (let index = 0; index < 50; index++)
    gateway.audio(1_000 + index * 20)
  gateway.event({ type: 'stop', timestamp: 2_480, duration_ms: 4_000 })
  await gateway.snapshot(true)

  assert.equal(gateway.segmenter.isRecording, false)
  assert.equal(gateway.segments.length, 1)
  assert.equal(gateway.segments[0]?.durationMs, 1_000)
  assert.deepEqual(Buffer.concat(gateway.segments[0]!.payloads), Buffer.alloc(8_000, 0x80))
})
