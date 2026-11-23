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
  assert.deepEqual(JSON.parse(await snapshotPromise), { 1234: { AUDIO: true, LISTENERS: 0, TYPE: 'HUB' } })
  status.terminate()
})
