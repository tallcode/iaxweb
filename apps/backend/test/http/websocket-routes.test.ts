import type { StatusSnapshot } from '../../src/allmon3/index.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import fastifyWebsocket from '@fastify/websocket'
import Fastify from 'fastify'
import { PublicStreams } from '../../src/gateway/public-streams.js'
import { registerWebSocketRoutes } from '../../src/http/websocket-routes.js'

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

  let resolveState: (state: string) => void = () => {}
  const statePromise = new Promise<string>((resolve) => {
    resolveState = resolve
  })
  const audio = await app.injectWS('/audio/1234', {}, {
    onInit: socket => socket.once('message', data => resolveState(data.toString())),
  })
  const state = await statePromise
  assert.deepEqual(JSON.parse(state), { listeners: 1, online: true, speaking: false, type: 'state' })
  assert.deepEqual(listenerCounts, [1])
  audio.terminate()
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(listenerCounts, [1, 0])

  let resolveSnapshot: (snapshot: string) => void = () => {}
  const snapshotPromise = new Promise<string>((resolve) => {
    resolveSnapshot = resolve
  })
  const status = await app.injectWS('/status', {}, {
    onInit: socket => socket.once('message', data => resolveSnapshot(data.toString())),
  })
  assert.deepEqual(JSON.parse(await snapshotPromise), {
    type: 'snapshot',
    nodes: { 1234: { AUDIO: true, LISTENERS: 0, TYPE: 'HUB' } },
  })
  status.terminate()
})

test('status updates use the state last sent to each connection', async (context) => {
  const app = Fastify()
  context.after(() => app.close())
  await app.register(fastifyWebsocket)
  const streams = new PublicStreams({ hasAiListener: () => false, audioSources: new Map() })
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

  const oldMessages: unknown[] = []
  const oldClient = await app.injectWS('/status', {}, {
    onInit: socket => socket.on('message', data => oldMessages.push(JSON.parse(data.toString()))),
  })

  current = { 1234: { ...initial[1234], NAME: 'Pending name' } }
  const newMessages: unknown[] = []
  const newClient = await app.injectWS('/status', {}, {
    onInit: socket => socket.on('message', data => newMessages.push(JSON.parse(data.toString()))),
  })

  current = { 1234: { ...initial[1234], CONNS: { ...connections, bravo: { ...connections.bravo, PTT: '1' } } } }
  streams.publishSnapshot(current)
  streams.publishAudioState('1234', { type: 'state', listeners: 1, online: true, speaking: false }, current)
  streams.publishSnapshot({})
  const spot = { at: '2026-11-23T00:00:00.000Z', callsign: 'BG5ABC', id: 'spot-1', node: '1234' }
  streams.publishSpot(spot)
  await new Promise<void>(resolve => setImmediate(resolve))
  oldClient.terminate()
  newClient.terminate()

  const state = { type: 'state', nodes: { 1234: { CONNS: connections, LISTENERS: 1, ONLINE: true } } }
  const remaining = [state, { type: 'snapshot', nodes: {} }, { type: 'spot', ...spot }]
  assert.deepEqual(oldMessages, [full, ...remaining])
  assert.deepEqual(newMessages, [
    { type: 'snapshot', nodes: { 1234: { ...full.nodes[1234], NAME: 'Pending name' } } },
    full,
    ...remaining,
  ])
})
