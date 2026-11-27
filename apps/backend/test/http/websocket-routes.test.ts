import type { FastifyInstance } from 'fastify'
import type { RawData, WebSocket } from 'ws'
import type { StatusSnapshot } from '../../src/allmon3/index.js'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { once } from 'node:events'
import test from 'node:test'
import fastifyWebsocket from '@fastify/websocket'
import { computeWebSocketProof, WEBSOCKET_VERIFICATION_FAILED, webSocketChallengeSchema } from '@iaxweb/contracts'
import Fastify from 'fastify'
import { PublicStreams } from '../../src/gateway/public-streams.js'
import { registerWebSocketRoutes } from '../../src/http/websocket-routes.js'

async function connectForVerification(app: FastifyInstance, path: string) {
  let receiveChallenge: (frame: { data: RawData, isBinary: boolean }) => void = () => {}
  const firstMessage = new Promise<{ data: RawData, isBinary: boolean }>((resolve) => {
    receiveChallenge = resolve
  })
  const messages: unknown[] = []
  const socket = await app.injectWS(path, {}, {
    onInit: (client) => {
      client.once('message', (data, isBinary) => {
        receiveChallenge({ data, isBinary })
        client.on('message', data => messages.push(JSON.parse(data.toString())))
      })
    },
  })
  const { data, isBinary } = await firstMessage
  assert.equal(isBinary, false)
  const { nonce } = webSocketChallengeSchema.parse(JSON.parse(data.toString()))
  return { messages, nonce, socket }
}

function verificationReply(nonce: string): string {
  return JSON.stringify({ type: 'verify', proof: computeWebSocketProof(nonce) })
}

async function verify({ nonce, socket }: { nonce: string, socket: WebSocket }): Promise<unknown> {
  const firstMessage = once(socket, 'message')
  socket.send(verificationReply(nonce))
  const [data] = await firstMessage as [RawData, boolean]
  return JSON.parse(data.toString()) as unknown
}

test('Fastify WebSocket routes validate audio nodes and track clients', async (context) => {
  const app = Fastify()
  context.after(() => app.close())
  await app.register(fastifyWebsocket)

  const listenerCounts: number[] = []
  const streams = new PublicStreams({
    hasAiListener: () => false,
    audioSources: new Map([['1234', {
      currentState: { listeners: 1, online: true, speaking: false, type: 'state' as const },
      setListenerCount: (count: number) => listenerCounts.push(count),
    }]]),
  })
  await app.register(registerWebSocketRoutes, {
    currentSnapshot: () => ({ 1234: { AUDIO: true, TYPE: 'HUB' } }),
    streams,
  })
  await app.ready()

  const missing = await app.inject({
    headers: { connection: 'upgrade', upgrade: 'websocket' },
    url: '/audio/missing',
  })
  assert.equal(missing.statusCode, 404)

  const audio = await connectForVerification(app, '/audio/1234')
  assert.deepEqual(listenerCounts, [])
  assert.deepEqual(await verify(audio), { listeners: 1, online: true, speaking: false, type: 'state' })
  assert.deepEqual(listenerCounts, [1])
  audio.socket.terminate()
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(listenerCounts, [1, 0])

  const status = await connectForVerification(app, '/status')
  assert.deepEqual(await verify(status), {
    type: 'snapshot',
    nodes: { 1234: { AUDIO: true, LISTENERS: 0, TYPE: 'HUB' } },
  })
  status.socket.terminate()
})

test('status connections receive fresh spot history once, followed by node and live spot updates', async (context) => {
  const app = Fastify()
  context.after(() => app.close())
  await app.register(fastifyWebsocket)
  const firstSpot = { at: '2026-11-23T00:00:00.000Z', callsign: 'BG5AAA', id: 'spot-1', node: '1234' }
  const nextSpot = { at: '2026-11-23T00:01:00.000Z', callsign: 'BG5BBB', id: 'spot-2', node: '1234' }
  let recentSpots = [firstSpot]
  let historyReads = 0
  const streams = new PublicStreams({
    hasAiListener: () => false,
    audioSources: new Map(),
    recentSpots: () => {
      historyReads++
      return recentSpots
    },
  })
  const initial: StatusSnapshot = {
    1234: {
      AUDIO: true,
      CONNS: { bravo: { CSTATE: 'ESTABLISHED', PTT: '0' }, alpha: { CSTATE: 'ESTABLISHED' } },
      NAME: 'Hub',
      ONLINE: true,
    },
  }
  const connections = { alpha: { CSTATE: 'ESTABLISHED' }, bravo: { CSTATE: 'ESTABLISHED' } }
  const full = { type: 'snapshot', nodes: { 1234: { AUDIO: true, CONNS: connections, LISTENERS: 0, NAME: 'Hub', ONLINE: true } } }
  let current = initial
  await app.register(registerWebSocketRoutes, { currentSnapshot: () => current, streams })
  await app.ready()

  const oldClient = await connectForVerification(app, '/status')
  assert.equal(historyReads, 0)
  streams.publishSpot(firstSpot)
  await verify(oldClient)

  const newClient = await connectForVerification(app, '/status')
  assert.notEqual(oldClient.nonce, newClient.nonce)
  assert.equal(historyReads, 1)
  recentSpots = [nextSpot, firstSpot]
  current = { 1234: { ...initial[1234], NAME: 'Pending name' } }
  await verify(newClient)

  current = { 1234: { ...initial[1234], CONNS: { ...connections, bravo: { ...connections.bravo, PTT: '1' } } } }
  streams.publishSnapshot(current)
  streams.publishAudioState('1234', { type: 'state', listeners: 1, online: true, speaking: false }, current)
  streams.publishSnapshot({})
  const spot = { ...nextSpot, callsign: 'BG5ABC', source: '1235' }
  streams.publishSpot(spot)
  await new Promise<void>(resolve => setImmediate(resolve))
  oldClient.socket.terminate()
  newClient.socket.terminate()

  const state = { type: 'state', nodes: { 1234: { CONNS: connections, LISTENERS: 1, ONLINE: true } } }
  const remaining = [state, { type: 'snapshot', nodes: {} }, { type: 'spot', ...spot }]
  assert.equal(historyReads, 2)
  assert.deepEqual(oldClient.messages, [{ type: 'history', spots: [firstSpot] }, full, ...remaining])
  assert.deepEqual(newClient.messages, [
    { type: 'history', spots: [nextSpot, firstSpot] },
    { type: 'snapshot', nodes: { 1234: { ...full.nodes[1234], NAME: 'Pending name' } } },
    full,
    ...remaining,
  ])
})

test('unverified WebSockets close without subscribing after an invalid reply or timeout', async (context) => {
  const app = Fastify()
  context.after(() => app.close())
  await app.register(fastifyWebsocket)

  let subscriptions = 0
  await app.register(registerWebSocketRoutes, {
    currentSnapshot: () => undefined,
    streams: {
      hasAudio: () => true,
      listenToAudio: () => subscriptions++,
      listenToStatus: () => subscriptions++,
    },
  })
  await app.ready()

  const malformed = await connectForVerification(app, '/status')
  const wrongProof = await connectForVerification(app, '/status')
  const nonceEcho = await connectForVerification(app, '/status')
  const binary = await connectForVerification(app, '/audio/1234')
  const invalidProof = computeWebSocketProof(wrongProof.nonce) === '00000000' ? '11111111' : '00000000'
  const invalidReplies = [
    { client: malformed, reply: '{' },
    { client: wrongProof, reply: JSON.stringify({ type: 'verify', proof: invalidProof }) },
    { client: nonceEcho, reply: JSON.stringify({ type: 'verify', nonce: nonceEcho.nonce }) },
    { client: binary, reply: Buffer.from(verificationReply(binary.nonce)) },
  ]
  for (const { client, reply } of invalidReplies) {
    const closed = once(client.socket, 'close')
    client.socket.send(reply)
    const [code, reason] = await closed as [number, Buffer]
    assert.equal(code, 1008)
    assert.equal(reason.toString(), WEBSOCKET_VERIFICATION_FAILED)
    assert.deepEqual(client.messages, [])
  }

  context.mock.timers.enable({ apis: ['setTimeout'] })
  const idle = await connectForVerification(app, '/status')
  const closed = once(idle.socket, 'close')
  context.mock.timers.tick(10_000)
  const [code, reason] = await closed as [number, Buffer]
  assert.equal(code, 1008)
  assert.equal(reason.toString(), 'Verification timed out')
  assert.deepEqual(idle.messages, [])
  assert.equal(subscriptions, 0)
})
