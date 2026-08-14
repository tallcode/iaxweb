import type { NatsConnection, Subscription } from '@nats-io/transport-node'
import assert from 'node:assert/strict'
import test from 'node:test'
import { isDisplayableCallsign, NO_CALLSIGN, SpotStore } from '../../src/ai/spot-store.js'

function spot(callsign: string) {
  return { at: '2026-08-12T12:00:00.000Z', callsign, id: 'abc123', node: '1900' }
}

function fakeConnection() {
  const published: Array<{ data: string, subject: string }> = []
  const subscribed: string[] = []
  let receive: ((data: Uint8Array) => void) | undefined
  let resolveClosed: (error: Error | undefined) => void = () => undefined
  const closed = new Promise<Error | undefined>((resolve) => {
    resolveClosed = resolve
  })
  async function* messages() {
    const data = await new Promise<Uint8Array>((resolve) => {
      receive = resolve
    })
    yield { data }
  }
  const subscription = {
    unsubscribe: () => undefined,
    [Symbol.asyncIterator]: messages,
  } as unknown as Subscription
  return {
    connection: {
      close: async () => resolveClosed(undefined),
      closed: () => closed,
      drain: async () => resolveClosed(undefined),
      publish: (subject: string, data: string) => published.push({ data, subject }),
      subscribe: (subject: string) => {
        subscribed.push(subject)
        return subscription
      },
    } as unknown as NatsConnection,
    disconnect: (error?: Error) => resolveClosed(error),
    published,
    receive: (event: ReturnType<typeof spot>) => receive?.(new TextEncoder().encode(JSON.stringify(event))),
    subscribed,
  }
}

test('publishes displayable spots under the configured Core NATS root', async () => {
  const fake = fakeConnection()
  const store = new SpotStore({ createConnection: async () => fake.connection, subjectPrefix: 'custom.nodes' })
  await store.start(() => undefined)

  store.publish(spot('BG5XXX'))
  assert.deepEqual(fake.published, [{
    data: JSON.stringify(spot('BG5XXX')),
    subject: 'custom.nodes.1900.ai.spot.BG5XXX',
  }])
  assert.deepEqual(fake.subscribed, ['custom.nodes.*.ai.spot.*'])
  await store.close()
})

test('retries an unavailable initial Spot connection', async () => {
  const fake = fakeConnection()
  const timers: Array<() => void> = []
  let attempts = 0
  const store = new SpotStore({
    createConnection: async () => {
      attempts++
      if (attempts === 1)
        throw new Error('offline')
      return fake.connection
    },
    retryDelayMs: 25,
    setTimer: (callback) => {
      timers.push(callback)
      return timers.length as unknown as ReturnType<typeof setTimeout>
    },
  })

  await store.start(() => undefined)
  assert.equal(attempts, 1)
  timers.shift()?.()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(attempts, 2)
  store.publish(spot('BG5XXX'))
  assert.equal(fake.published.length, 1)
  await store.close()
})

test('reconnects after an established Spot connection closes', async () => {
  const first = fakeConnection()
  const second = fakeConnection()
  const timers: Array<() => void> = []
  let attempts = 0
  const store = new SpotStore({
    createConnection: async () => attempts++ === 0 ? first.connection : second.connection,
    setTimer: (callback) => {
      timers.push(callback)
      return timers.length as unknown as ReturnType<typeof setTimeout>
    },
  })

  await store.start(() => undefined)
  first.disconnect(new Error('connection lost'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(timers.length, 1)
  timers.shift()?.()
  await new Promise(resolve => setImmediate(resolve))
  store.publish(spot('BG5XXX'))
  assert.equal(second.published.length, 1)
  await store.close()
})

test('forwards valid Core NATS spots and filters N0CALL', async () => {
  const fake = fakeConnection()
  const received: string[] = []
  const store = new SpotStore({ createConnection: async () => fake.connection })
  await store.start(event => received.push(event.callsign))

  fake.receive(spot('BG5ABC'))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(received, ['BG5ABC'])
  assert.equal(isDisplayableCallsign(NO_CALLSIGN), false)
  assert.equal(isDisplayableCallsign('BG5ABC'), true)
  await store.close()
})

test('forwards manual review events including N0CALL by record id', async () => {
  const fake = fakeConnection()
  const received: Array<{ at: string, callsign: string, id: string, node: string }> = []
  const store = new SpotStore({ createConnection: async () => fake.connection })
  await store.start(event => received.push(event))

  const reviewed = spot(NO_CALLSIGN)
  store.publishReview(reviewed)
  assert.equal(fake.published[0]?.subject, 'iaxmon.nodes.1900.ai.spot.N0CALL')
  fake.receive(reviewed)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(received, [reviewed])
  await store.close()
})
