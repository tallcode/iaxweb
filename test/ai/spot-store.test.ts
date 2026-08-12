import type { NatsConnection, Subscription } from '@nats-io/transport-node'
import assert from 'node:assert/strict'
import test from 'node:test'
import { isDisplayableCallsign, NO_CALLSIGN, SpotStore } from '../../src/ai/spot-store.js'

function spot(callsign: string) {
  return { at: '2026-08-12T12:00:00.000Z', callsign, node: '1900', segmentId: 'abc123' }
}

function fakeConnection() {
  const published: Array<{ data: string, subject: string }> = []
  let receive: ((data: Uint8Array) => void) | undefined
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
      drain: async () => undefined,
      publish: (subject: string, data: string) => published.push({ data, subject }),
      subscribe: () => subscription,
    } as unknown as NatsConnection,
    published,
    receive: (event: ReturnType<typeof spot>) => receive?.(new TextEncoder().encode(JSON.stringify(event))),
  }
}

test('publishes displayable spots to Core NATS', async () => {
  const fake = fakeConnection()
  const store = new SpotStore({ createConnection: async () => fake.connection })
  await store.start(() => undefined)

  store.publish(spot('BG5XXX'))
  assert.deepEqual(fake.published, [{
    data: JSON.stringify(spot('BG5XXX')),
    subject: 'iaxmon.nodes.1900.ai.spot.BG5XXX',
  }])
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
