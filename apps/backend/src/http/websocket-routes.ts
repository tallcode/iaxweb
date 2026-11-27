import type { FastifyInstance } from 'fastify'
import type { RawData, WebSocket } from 'ws'
import type { StatusSnapshot } from '../allmon3/index.js'
import type { PublicStreams } from '../gateway/public-streams.js'
import { randomBytes } from 'node:crypto'
import { computeWebSocketProof, WEBSOCKET_VERIFICATION_FAILED, webSocketVerifySchema } from '@iaxweb/contracts'

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
  }, async (socket, request) => {
    if (await verifySocket(socket) && socket.readyState === socket.OPEN)
      streams.listenToAudio(request.params.nodeId, socket)
  })

  app.get('/status', { websocket: true }, async (socket) => {
    if (await verifySocket(socket) && socket.readyState === socket.OPEN)
      streams.listenToStatus(socket, currentSnapshot())
  })
}

function verifySocket(socket: WebSocket): Promise<boolean> {
  const nonce = randomBytes(16).toString('hex')
  const expectedProof = computeWebSocketProof(nonce)
  return new Promise((resolve) => {
    const timer = setTimeout(finish, 10_000, false, 'Verification timed out')
    timer.unref()

    function finish(verified: boolean, closeReason?: string): void {
      clearTimeout(timer)
      socket.off('message', onVerify)
      socket.off('close', onClose)
      if (closeReason)
        socket.close(1008, closeReason)
      resolve(verified)
    }

    function onClose(): void {
      finish(false)
    }

    function onVerify(data: RawData, isBinary: boolean): void {
      if (!isBinary && matchesChallenge(data, expectedProof))
        finish(true)
      else
        finish(false, WEBSOCKET_VERIFICATION_FAILED)
    }

    socket.once('message', onVerify)
    socket.once('close', onClose)
    socket.send(JSON.stringify({ type: 'challenge', nonce }))
  })
}

function matchesChallenge(data: RawData, expectedProof: string): boolean {
  try {
    const parsed = webSocketVerifySchema.safeParse(JSON.parse(data.toString()))
    return parsed.success && parsed.data.proof === expectedProof
  }
  catch {
    return false
  }
}
