import type { WebSocket } from 'ws'
import type { SpotEvent } from './ai/spot-store.js'
import type { StatusSnapshot } from './allmon3/index.js'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import fastifyCookie from '@fastify/cookie'
import fastifyWebsocket from '@fastify/websocket'
import { connect } from '@nats-io/transport-node'
import { config as loadEnv } from 'dotenv'
import Fastify from 'fastify'
import { AdminAuth } from './admin/auth.js'
import { LoginRateLimiter } from './admin/login-rate-limiter.js'
import { SegmentRepository } from './ai/segment-repository.js'
import { AiService } from './ai/service.js'
import { SpotStore } from './ai/spot-store.js'
import { Allmon3StatusService, parseNodeDefinitions, publicStatusSnapshot } from './allmon3/index.js'
import { loadAiConfig, loadConfig } from './config.js'
import { createConnectionOptions, NatsAudioService } from './gateway/nats-audio.js'
import { startWebSocketHeartbeat } from './gateway/websocket-heartbeat.js'
import { registerAdminRoutes } from './http/admin-routes.js'
import { registerStaticRoutes } from './http/static-routes.js'
import { registerWebSocketRoutes } from './http/websocket-routes.js'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
loadEnv({ path: resolve(repositoryRoot, '.env'), quiet: true })

const config = loadConfig()
const aiConfig = loadAiConfig()
const nodeDefinitions = parseNodeDefinitions(JSON.parse(
  readFileSync(resolve(repositoryRoot, 'config/nodes.json'), 'utf8'),
) as unknown)
const aiNodeIds = Object.entries(nodeDefinitions)
  .filter(([, definition]) => definition.AI === true)
  .map(([nodeId]) => nodeId)

if (aiNodeIds.length > 0 && !aiConfig.apiKey)
  throw new Error(`DASHSCOPE_API_KEY is required to enable AI for nodes: ${aiNodeIds.join(', ')}`)

const segmentRepository = aiConfig.persistenceEnabled ? new SegmentRepository(aiConfig.databaseFile) : undefined
const adminAuth = segmentRepository ? new AdminAuth(aiConfig.adminFile, aiConfig.sessionsFile) : undefined
const audioClients = new Set<WebSocket>()
const statusClients = new Set<WebSocket>()
const audioClientNodes = new WeakMap<WebSocket, string>()
const audioListeners = new Map<string, number>()
const loginRateLimiter = new LoginRateLimiter()

const spotStore = new SpotStore({
  createConnection: () => connect({
    ...createConnectionOptions(config.nats),
    name: 'iaxweb-spots',
    maxReconnectAttempts: -1,
  }),
  subjectPrefix: config.nats.subjectRoot,
})
const allmon3 = new Allmon3StatusService({
  ...config.allmon3,
  nodes: nodeDefinitions,
  onChange: publishAllmon3Status,
})
const aiService = aiNodeIds.length > 0
  ? new AiService({
      config: aiConfig,
      nodeIds: aiNodeIds,
      onSpot: spot => spotStore.publish(spot),
      ...(segmentRepository ? { repository: segmentRepository } : {}),
    })
  : undefined

const natsAudio = new Map<string, NatsAudioService>()
for (const [nodeId, definition] of Object.entries(nodeDefinitions)) {
  if (definition.AUDIO !== true)
    continue
  audioListeners.set(nodeId, 0)
  natsAudio.set(nodeId, new NatsAudioService({
    config: config.nats,
    nodeId,
    onAudio: (data) => {
      broadcastAudio(nodeId, data, true)
      aiService?.pushFrame(nodeId, data)
    },
    onEvent: (text) => {
      broadcastAudio(nodeId, text, false)
      aiService?.onEvent(nodeId, text)
    },
    onState: (state) => {
      publishAudioState(nodeId, state)
      aiService?.onState(nodeId, state)
    },
  }))
}

const app = Fastify({
  bodyLimit: 16_384,
  logger: true,
})

app.register(fastifyCookie)
app.register(fastifyWebsocket, {
  errorHandler(error, socket, request) {
    request.log.error(error, 'WebSocket handler failed')
    socket.terminate()
  },
  options: {
    maxPayload: 16_384,
  },
})

app.get('/healthz', async () => ({
  allmon3: Boolean(allmon3.currentSnapshot),
  nats: natsAudio.size > 0 && [...natsAudio.values()].every(service => service.connected),
  ok: true,
}))

app.get('/api/spots', async (_request, reply) =>
  reply.header('cache-control', 'no-store').send(segmentRepository?.recentSpots() ?? []))

app.register(registerAdminRoutes, {
  adminAuth,
  loginRateLimiter,
  prefix: '/api/admin',
  recordingsDirectory: aiConfig.recordingsDirectory,
  segmentRepository,
  sessionMaxAgeSeconds: AdminAuth.sessionMaxAgeSeconds,
  spotStore,
})

app.register(registerWebSocketRoutes, {
  allmon3,
  audioClientNodes,
  audioClients,
  audioListeners,
  natsAudio,
  onAudioListenerChange: updateAudioListenerCount,
  statusClients,
})

app.register(registerStaticRoutes, {
  adminRoot: resolve(repositoryRoot, 'apps/admin/dist'),
  publicRoot: resolve(repositoryRoot, 'apps/public/dist'),
})

let shuttingDown = false
let stopWebSocketHeartbeat: (() => void) | undefined

async function main(): Promise<void> {
  await app.ready()
  stopWebSocketHeartbeat = startWebSocketHeartbeat(app.websocketServer)

  void spotStore.start(broadcastSpot)
  allmon3.start()
  for (const [nodeId, service] of natsAudio.entries()) {
    // The AI listener counts as a listener so iaxmon keeps the IAX call up
    // even when no browser is playing.
    if (aiService?.hasNode(nodeId))
      service.setListenerCount(1)
    service.start()
  }

  await app.listen({ host: config.host, port: config.port })
}

function broadcastAudio(nodeId: string, data: Uint8Array | string, binary: boolean): void {
  for (const client of audioClients) {
    if (client.readyState !== client.OPEN || audioClientNodes.get(client) !== nodeId)
      continue

    // Real-time audio is more useful dropped than delivered late.
    if (binary && client.bufferedAmount > 4 * 1024)
      continue

    client.send(data, { binary })
  }
}

function broadcastSpot(spot: SpotEvent): void {
  const message = JSON.stringify({ type: 'spot', ...spot })
  for (const client of statusClients) {
    if (client.readyState === client.OPEN)
      client.send(message)
  }
}

function updateAudioListenerCount(nodeId: string): void {
  let count = 0
  for (const client of audioClients) {
    if (client.readyState === client.OPEN && audioClientNodes.get(client) === nodeId)
      count++
  }
  natsAudio.get(nodeId)?.setListenerCount(count + (aiService?.hasNode(nodeId) ? 1 : 0))
}

function publishAudioState(nodeId: string, state: { listeners?: number }): void {
  broadcastAudio(nodeId, JSON.stringify(state), false)

  const listeners = state.listeners ?? 0
  if (audioListeners.get(nodeId) === listeners)
    return
  audioListeners.set(nodeId, listeners)

  const snapshot = allmon3.currentSnapshot
  if (snapshot)
    publishAllmon3Status(snapshot)
}

function publishAllmon3Status(snapshot: StatusSnapshot): void {
  const message = JSON.stringify(publicStatusSnapshot(snapshot, audioListeners))
  for (const client of statusClients) {
    if (client.readyState === client.OPEN)
      client.send(message)
  }
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown)
    return
  shuttingDown = true
  app.log.info({ signal }, 'Shutting down')

  allmon3.stop()
  aiService?.stop()
  stopWebSocketHeartbeat?.()
  for (const client of app.websocketServer.clients)
    client.close(1001, 'Server shutting down')
  await app.close()
  await Promise.all([...natsAudio.values()].map(service => service.stop()))
  await spotStore.close()
  if (!aiService)
    segmentRepository?.close()
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(signal)
      .catch(error => app.log.error(error, 'Shutdown failed'))
      .finally(() => process.exit(0))
  })
}

void main().catch((error) => {
  app.log.error(error, 'Unable to start iaxweb')
  void shutdown('startup failure').finally(() => {
    process.exitCode = 1
  })
})
