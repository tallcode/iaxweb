import type { NodeDefinitions } from './allmon3/index.js'
import type { AiConfig, AppConfig } from './config.js'
import type { SpotEvent } from './spots/spot-store.js'
import { resolve } from 'node:path'
import fastifyCompress from '@fastify/compress'
import fastifyCookie from '@fastify/cookie'
import fastifyWebsocket from '@fastify/websocket'
import { connect } from '@nats-io/transport-node'
import Fastify from 'fastify'
import { AdminAuth } from './admin/auth.js'
import { LoginRateLimiter } from './admin/login-rate-limiter.js'
import { AudioQualityService } from './ai/audio-quality.js'
import { AiService } from './ai/service.js'
import { SpeakerReferenceService } from './ai/speaker-references.js'
import { Allmon3StatusService } from './allmon3/index.js'
import { createConnectionOptions, NatsAudioService } from './gateway/nats-audio.js'
import { PublicStreams } from './gateway/public-streams.js'
import { startWebSocketHeartbeat } from './gateway/websocket-heartbeat.js'
import { registerAdminRoutes } from './http/admin-routes.js'
import { registerCoverageRoutes } from './http/coverage-routes.js'
import { registerNotFoundHandler } from './http/not-found.js'
import { registerPublicRoutes } from './http/public-routes.js'
import { registerStaticRoutes } from './http/static-routes.js'
import { registerWebSocketRoutes } from './http/websocket-routes.js'
import { RecordRepository } from './records/record-repository.js'
import { StatsCache } from './records/stats-cache.js'
import { SpotStore } from './spots/spot-store.js'

interface ApplicationOptions {
  config: AppConfig
  aiConfig: AiConfig
  nodeDefinitions: NodeDefinitions
  repositoryRoot: string
}

export function createApplication({ config, aiConfig, nodeDefinitions, repositoryRoot }: ApplicationOptions) {
  const aiNodeIds = Object.entries(nodeDefinitions)
    .filter(([, definition]) => definition.AI === true)
    .map(([nodeId]) => nodeId)

  if (aiNodeIds.length > 0 && !aiConfig.asr.apiKey)
    throw new Error(`AI_ASR_API_KEY is required to enable AI for nodes: ${aiNodeIds.join(', ')}`)
  if (aiNodeIds.length > 0 && aiConfig.llm.enabled && !aiConfig.llm.apiKey)
    throw new Error(`AI_LLM_API_KEY is required when AI_LLM_ENABLED=true for nodes: ${aiNodeIds.join(', ')}`)

  const recordRepository = aiConfig.persistenceEnabled ? new RecordRepository(aiConfig.databaseFile) : undefined
  const audioQuality = new AudioQualityService()
  const speakerReferences = recordRepository
    ? new SpeakerReferenceService({ repository: recordRepository, recordingsDirectory: aiConfig.recordingsDirectory, modelFile: aiConfig.speakerModelFile, audioQuality })
    : undefined
  const adminAuth = recordRepository ? new AdminAuth(aiConfig.adminFile, aiConfig.sessionsFile) : undefined

  const spotPublishingEnabled = aiConfig.llm.publishSpot
  const spotStore = spotPublishingEnabled
    ? new SpotStore({
        createConnection: () => connect({
          ...createConnectionOptions(config.nats),
          name: 'iaxweb-spots',
          maxReconnectAttempts: -1,
        }),
        subjectPrefix: config.nats.subjectRoot,
      })
    : undefined
  const natsAudio = new Map<string, NatsAudioService>()
  const streams = new PublicStreams({
    audioSources: natsAudio,
    hasAiListener: nodeId => aiNodeIds.includes(nodeId),
    ...(spotPublishingEnabled ? { recentSpots: () => recordRepository?.recentSpots() ?? [] } : {}),
    spotPublishingEnabled,
  })
  const allmon3 = new Allmon3StatusService({
    ...config.allmon3,
    nodes: nodeDefinitions,
    onChange: snapshot => streams.publishSnapshot(snapshot),
  })

  const aiService = aiNodeIds.length > 0
    ? new AiService({
        config: aiConfig,
        audioQuality,
        getSourceRepeaterId: nodeId => allmon3.sourceRepeaterId(nodeId),
        nodeIds: aiNodeIds,
        ...(spotStore ? { onSpot: (spot: SpotEvent) => spotStore.publish(spot) } : {}),
        ...(recordRepository ? { repository: recordRepository } : {}),
        ...(speakerReferences ? { speakerReferences } : {}),
      })
    : undefined

  for (const [nodeId, definition] of Object.entries(nodeDefinitions)) {
    if (definition.AUDIO !== true)
      continue
    natsAudio.set(nodeId, new NatsAudioService({
      config: config.nats,
      nodeId,
      onAudio: (data) => {
        streams.publishAudio(nodeId, data, true)
        aiService?.pushFrame(nodeId, data)
      },
      onEvent: (text) => {
        streams.publishAudio(nodeId, text, false)
        aiService?.onEvent(nodeId, text)
      },
      onState: (state) => {
        streams.publishAudioState(nodeId, state, allmon3.currentSnapshot)
        aiService?.onState(nodeId, state)
      },
    }))
  }

  const app = Fastify({ bodyLimit: 16_384, logger: true })
  registerNotFoundHandler(app)
  const stats = recordRepository && new StatsCache(
    resolve(repositoryRoot, 'data/stats/speech-activity.json'),
    recordRepository,
    error => app.log.error({ err: error }, 'Unable to refresh statistics'),
  )

  app.register(fastifyCookie)
  app.register(fastifyCompress)
  app.register(fastifyWebsocket, {
    errorHandler(error, socket, request) {
      request.log.error(error, 'WebSocket handler failed')
      socket.terminate()
    },
    options: { maxPayload: 16_384 },
  })

  app.register(registerPublicRoutes, {
    getHealth: () => ({
      allmon3: Boolean(allmon3.currentSnapshot),
      nats: natsAudio.size > 0 && [...natsAudio.values()].every(service => service.connected),
    }),
    ...(stats ? { stats } : {}),
  })
  app.register(registerCoverageRoutes, { directory: resolve(repositoryRoot, 'data/coverage') })
  app.register(registerAdminRoutes, {
    adminAuth,
    loginRateLimiter: new LoginRateLimiter(),
    nodeDefinitions,
    prefix: '/api/admin',
    recordingsDirectory: aiConfig.recordingsDirectory,
    recordRepository,
    speakerReferences,
    sessionMaxAgeSeconds: AdminAuth.sessionMaxAgeSeconds,
    ...(spotStore ? { spotStore } : {}),
  })
  app.register(registerWebSocketRoutes, { currentSnapshot: () => allmon3.currentSnapshot, streams })
  app.register(registerStaticRoutes, {
    adminRoot: resolve(repositoryRoot, 'apps/admin/dist'),
    nodeDefinitions,
    publicRoot: resolve(repositoryRoot, 'apps/public/dist'),
    ...(config.publicSiteUrl ? { publicSiteUrl: config.publicSiteUrl } : {}),
  })

  let shuttingDown = false
  let stopWebSocketHeartbeat: (() => void) | undefined

  async function start(): Promise<void> {
    await app.ready()
    speakerReferences?.start()
    stopWebSocketHeartbeat = startWebSocketHeartbeat(app.websocketServer)

    void spotStore?.start(spot => streams.publishSpot(spot))
    allmon3.start()
    for (const [nodeId, service] of natsAudio) {
      // The AI listener keeps the IAX call up even when no browser is playing.
      if (aiService?.hasNode(nodeId))
        service.setListenerCount(1)
      service.start()
    }

    await app.listen({ host: config.host, port: config.port })
  }

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown)
      return
    shuttingDown = true
    app.log.info({ signal }, 'Shutting down')

    try {
      allmon3.stop()
      aiService?.stop()
      speakerReferences?.stop()
      audioQuality.stop()
      stopWebSocketHeartbeat?.()
      for (const client of app.websocketServer.clients)
        client.close(1001, 'Server shutting down')
      await app.close()
      await Promise.all([...natsAudio.values()].map(service => service.stop()))
      await spotStore?.close()
    }
    finally {
      recordRepository?.close()
    }
  }

  return { app, start, shutdown }
}
