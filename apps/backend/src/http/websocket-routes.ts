import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import type { Allmon3StatusService } from '../allmon3/index.js'
import type { NatsAudioService } from '../gateway/nats-audio.js'
import { publicStatusSnapshot } from '../allmon3/index.js'

interface AudioParams {
  nodeId: string
}

interface WebSocketRoutesOptions {
  allmon3: Pick<Allmon3StatusService, 'currentSnapshot'>
  audioClientNodes: WeakMap<WebSocket, string>
  audioClients: Set<WebSocket>
  audioListeners: ReadonlyMap<string, number>
  natsAudio: ReadonlyMap<string, Pick<NatsAudioService, 'currentState'>>
  onAudioListenerChange: (nodeId: string) => void
  statusClients: Set<WebSocket>
}

export async function registerWebSocketRoutes(app: FastifyInstance, options: WebSocketRoutesOptions): Promise<void> {
  app.get<{ Params: AudioParams }>('/audio/:nodeId', {
    websocket: true,
    preValidation: async (request, reply) => {
      if (!options.natsAudio.has(request.params.nodeId))
        return reply.code(404).send('Unknown audio node')
    },
  }, (socket, request) => {
    const { nodeId } = request.params
    const service = options.natsAudio.get(nodeId)
    if (!service) {
      socket.close(1008, 'Unknown audio node')
      return
    }

    options.audioClients.add(socket)
    options.audioClientNodes.set(socket, nodeId)
    options.onAudioListenerChange(nodeId)
    socket.send(JSON.stringify(service.currentState))
    socket.once('close', () => {
      options.audioClients.delete(socket)
      options.onAudioListenerChange(nodeId)
    })
  })

  app.get('/status', { websocket: true }, (socket) => {
    options.statusClients.add(socket)
    socket.once('close', () => options.statusClients.delete(socket))
    const snapshot = options.allmon3.currentSnapshot
    if (snapshot)
      socket.send(JSON.stringify(publicStatusSnapshot(snapshot, options.audioListeners)))
  })
}
