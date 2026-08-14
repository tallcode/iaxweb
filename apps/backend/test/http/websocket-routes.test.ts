import type { WebSocket } from 'ws'
import assert from 'node:assert/strict'
import test from 'node:test'
import fastifyWebsocket from '@fastify/websocket'
import Fastify from 'fastify'
import { registerWebSocketRoutes } from '../../src/http/websocket-routes.js'

test('Fastify WebSocket routes validate audio nodes and track clients', async (context) => {
  const app = Fastify()
  context.after(() => app.close())
  await app.register(fastifyWebsocket)

  const audioClients = new Set<WebSocket>()
  const statusClients = new Set<WebSocket>()
  const listenerChanges: string[] = []
  await app.register(registerWebSocketRoutes, {
    allmon3: { currentSnapshot: undefined },
    audioClientNodes: new WeakMap(),
    audioClients,
    audioListeners: new Map(),
    natsAudio: new Map([['1234', {
      currentState: { listeners: 1, online: true, speaking: false, type: 'state' as const },
    }]]),
    onAudioListenerChange: nodeId => listenerChanges.push(nodeId),
    statusClients,
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
  assert.equal(audioClients.size, 1)
  assert.deepEqual(listenerChanges, ['1234'])
  audio.terminate()
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(audioClients.size, 0)
  assert.deepEqual(listenerChanges, ['1234', '1234'])

  const status = await app.injectWS('/status')
  assert.equal(statusClients.size, 1)
  status.terminate()
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(statusClients.size, 0)
})
