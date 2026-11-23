import type { FastifyInstance } from 'fastify'
import type { StatusSnapshot } from '../allmon3/index.js'
import type { PublicStreams } from '../gateway/public-streams.js'

interface AudioParams {
  nodeId: string
}

interface WebSocketRoutesOptions {
  currentSnapshot: () => StatusSnapshot | undefined
  streams: Pick<PublicStreams, 'hasAudio' | 'listenToAudio' | 'listenToStatus'>
}

export async function registerWebSocketRoutes(app: FastifyInstance, { currentSnapshot, streams }: WebSocketRoutesOptions): Promise<void> {
  app.get<{ Params: AudioParams }>('/audio/:nodeId', {
    websocket: true,
    preValidation: async (request, reply) => {
      if (!streams.hasAudio(request.params.nodeId))
        return reply.code(404).send('Unknown audio node')
    },
  }, (socket, request) => streams.listenToAudio(request.params.nodeId, socket))

  app.get('/status', { websocket: true }, socket => streams.listenToStatus(socket, currentSnapshot()))
}
