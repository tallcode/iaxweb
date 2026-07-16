import type { WebSocket, WebSocketServer } from 'ws'

interface HeartbeatTarget {
  name: string
  server: WebSocketServer
}

const expectedCloseCodes = new Set([1000, 1001])

export function startWebSocketHeartbeat(
  targets: HeartbeatTarget[],
  intervalMs = 25_000,
): () => void {
  const responsiveClients = new WeakSet<WebSocket>()

  for (const target of targets) {
    target.server.on('connection', (client, request) => {
      responsiveClients.add(client)
      client.on('pong', () => responsiveClients.add(client))
      client.on('close', (code, reason) => {
        if (!expectedCloseCodes.has(code)) {
          const address = request.socket.remoteAddress ?? 'unknown'
          const detail = reason.length > 0 ? `: ${reason.toString()}` : ''
          console.warn(`${target.name} WebSocket closed unexpectedly (${address}, code ${code}${detail})`)
        }
      })
    })
  }

  const timer = setInterval(() => {
    for (const target of targets) {
      for (const client of target.server.clients) {
        if (client.readyState !== client.OPEN)
          continue

        if (!responsiveClients.has(client)) {
          client.terminate()
          continue
        }

        responsiveClients.delete(client)
        client.ping()
      }
    }
  }, intervalMs)
  timer.unref()

  return () => clearInterval(timer)
}
