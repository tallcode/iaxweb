import type { NatsConnection } from '@nats-io/transport-node'
import type { JetStreamLike, JetStreamManagerLike, SpotEvent } from '../../src/ai/spot-store.js'

import assert from 'node:assert/strict'

import test from 'node:test'
import { SpotStore } from '../../src/ai/spot-store.js'

const TEST_NOW = Date.parse('2026-08-09T13:00:00.000Z')

interface FakeJsOptions {
  history: Uint8Array[]
  live?: Uint8Array[]
  published: Array<{ subject: string, data: string | Uint8Array }>
  failPublish?: boolean
}

function fakeManager(messages = 0): JetStreamManagerLike {
  return {
    consumers: {
      add: async () => ({ name: 'probe' }),
    },
    streams: {
      add: async () => undefined,
      info: async () => ({ state: { messages } }),
    },
  }
}

function fakeJs(options: FakeJsOptions): JetStreamLike {
  const history = [...options.history]
  return {
    consumers: {
      get: async () => ({
        fetch: async () => {
          const iterable = {
            async* [Symbol.asyncIterator]() {
              for (const data of history)
                yield { data }
            },
          }
          return { ...iterable, close: async () => undefined }
        },
        consume: async () => {
          const iterable = {
            async* [Symbol.asyncIterator]() {
              for (const data of options.live ?? [])
                yield { data }
            },
          }
          return { ...iterable, close: async () => undefined }
        },
      }),
    },
    publish: async (subject, data) => {
      if (options.failPublish)
        throw new Error('publish failed')
      options.published.push({ subject, data })
    },
  }
}

function fakeConnection(): NatsConnection {
  return {} as NatsConnection
}

function spot(callsign: string, overrides: Partial<SpotEvent> = {}): SpotEvent {
  return { at: '2026-08-09T12:00:00.000Z', callsign, node: '1900', segmentId: 'abc123', ...overrides }
}

test('creates the stream when missing and loads history', async () => {
  let streamConfig: Record<string, unknown> | undefined
  let infoCalls = 0
  const published: Array<{ subject: string, data: string | Uint8Array }> = []
  const store = new SpotStore({
    createConnection: async () => fakeConnection(),
    jetstreamManagerImpl: async () => ({
      consumers: { add: async () => ({ name: 'probe' }) },
      streams: {
        add: async (cfg) => {
          streamConfig = cfg
        },
        // The stream is missing on the first probe (creating it), then
        // exists afterwards (loading history).
        info: async () => {
          infoCalls++
          if (infoCalls === 1)
            throw new Error('stream not found')
          return { state: { messages: 1 } }
        },
      },
    }),
    jetstreamImpl: () => fakeJs({ history: [new TextEncoder().encode(JSON.stringify(spot('BG5AAA', { node: '1900' })))], published }),
    now: () => TEST_NOW,
  })

  await store.start()
  assert.equal(store.isAvailable, true)
  assert.equal(streamConfig?.name, 'AI_SPOT')
  assert.equal(streamConfig?.max_msgs_per_subject, 1)
  const recent = await store.recent()
  assert.equal(recent.length, 1)
  assert.equal(recent[0]?.callsign, 'BG5AAA')
})

test('reuses an existing stream and skips the add', async () => {
  let addCalled = 0
  const published: Array<{ subject: string, data: string | Uint8Array }> = []
  const store = new SpotStore({
    createConnection: async () => fakeConnection(),
    jetstreamManagerImpl: async () => ({
      consumers: { add: async () => ({ name: 'probe' }) },
      streams: {
        add: async () => {
          addCalled++
        },
        info: async () => ({ state: { messages: 1 } }),
      },
    }),
    jetstreamImpl: () => fakeJs({ history: [new TextEncoder().encode(JSON.stringify(spot('BG5BBB')))], published }),
    now: () => TEST_NOW,
  })

  await store.start()
  assert.equal(addCalled, 0)
  const recent = await store.recent()
  assert.equal(recent.length, 1)
  assert.equal(recent[0]?.callsign, 'BG5BBB')
})

test('keeps the newest spot per callsign', async () => {
  const published: Array<{ subject: string, data: string | Uint8Array }> = []
  const store = new SpotStore({
    createConnection: async () => fakeConnection(),
    jetstreamManagerImpl: async () => fakeManager(),
    jetstreamImpl: () => fakeJs({ history: [], published }),
    now: () => TEST_NOW,
  })
  await store.start()

  await store.record(spot('BG5XXX', { at: '2026-08-09T12:00:00.000Z' }))
  await store.record(spot('BG5XXX', { at: '2026-08-09T12:10:00.000Z' }))
  await store.record(spot('BG5YYY', { at: '2026-08-09T12:20:00.000Z' }))

  const recent = await store.recent()
  assert.equal(recent.length, 2)
  // Most recent first.
  assert.equal(recent[0]?.callsign, 'BG5YYY')
  assert.equal(recent[1]?.callsign, 'BG5XXX')
  assert.equal(recent[1]?.at, '2026-08-09T12:10:00.000Z')
})

test('publishes spots to the callsign subject', async () => {
  const published: Array<{ subject: string, data: string | Uint8Array }> = []
  const store = new SpotStore({
    createConnection: async () => fakeConnection(),
    jetstreamManagerImpl: async () => fakeManager(),
    jetstreamImpl: () => fakeJs({ history: [], published }),
    now: () => TEST_NOW,
  })
  await store.start()

  assert.equal(await store.record(spot('BG5XXX', { node: '1900' })), 'published')
  assert.equal(published.length, 1)
  assert.equal(published[0]?.subject, 'iaxmon.nodes.1900.ai.spot.BG5XXX')
  const data = published[0]?.data ?? new Uint8Array()
  const encoded = typeof data === 'string' ? new TextEncoder().encode(data) : data
  const parsed = JSON.parse(new TextDecoder().decode(encoded)) as SpotEvent
  assert.equal(parsed.callsign, 'BG5XXX')
})

test('degrades gracefully without JetStream', async () => {
  const store = new SpotStore({
    createConnection: async () => fakeConnection(),
    jetstreamManagerImpl: async () => {
      throw new Error('no jetstream')
    },
    jetstreamImpl: () => fakeJs({ history: [], published: [] }),
    now: () => TEST_NOW,
  })

  await store.start()
  assert.equal(store.isAvailable, false)
  // Session-only view still records and serves.
  assert.equal(await store.record(spot('BG5XXX')), 'stored')
  const recent = await store.recent()
  assert.equal(recent.length, 1)
  assert.equal(recent[0]?.callsign, 'BG5XXX')
})

test('consume forwards live spots and updates the view', async () => {
  const published: Array<{ subject: string, data: string | Uint8Array }> = []
  const store = new SpotStore({
    createConnection: async () => fakeConnection(),
    jetstreamManagerImpl: async () => fakeManager(),
    jetstreamImpl: () => fakeJs({
      history: [],
      live: [new TextEncoder().encode(JSON.stringify(spot('BG5LIV')))],
      published,
    }),
    now: () => TEST_NOW,
  })
  await store.start()

  const received: SpotEvent[] = []
  await store.consume(s => received.push(s))
  assert.equal(received.length, 1)
  assert.equal(received[0]?.callsign, 'BG5LIV')
  // The live spot is also merged into the recent view.
  const recent = await store.recent()
  assert.equal(recent[0]?.callsign, 'BG5LIV')
})

test('expires spots older than 24 hours', async () => {
  const time = 1_000_000_000
  const published: Array<{ subject: string, data: string | Uint8Array }> = []
  const store = new SpotStore({
    createConnection: async () => fakeConnection(),
    jetstreamManagerImpl: async () => fakeManager(),
    jetstreamImpl: () => fakeJs({ history: [], published }),
    now: () => time,
  })
  await store.start()

  const old = spot('BG5OLD', { at: new Date(time - 25 * 60 * 60 * 1_000).toISOString() })
  const fresh = spot('BG5NEW', { at: new Date(time).toISOString() })
  await store.record(old)
  await store.record(fresh)

  const recent = await store.recent()
  assert.deepEqual(recent.map(r => r.callsign), ['BG5NEW'])
})

test('rejects malformed callsigns before storing or publishing', async () => {
  const published: Array<{ subject: string, data: string | Uint8Array }> = []
  const store = new SpotStore({
    createConnection: async () => fakeConnection(),
    jetstreamManagerImpl: async () => fakeManager(),
    jetstreamImpl: () => fakeJs({ history: [], published }),
    now: () => TEST_NOW,
  })
  await store.start()

  assert.equal(await store.record(spot('BG55BAD')), 'rejected')
  assert.deepEqual(await store.recent(), [])
  assert.equal(published.length, 0)
})
