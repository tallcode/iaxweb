import type { WebSocket, WebSocketServer } from 'ws'

interface HeartbeatTarget {
  name: string
  server: WebSocketServer
}

// Browsers commonly produce 1006 when a tab reloads/closes or the network
// disappears before a close frame can be exchanged. Reconnect logic lives on
// the client, so this is expected transport churn rather than a server error.
const expectedCloseCodes = new Set([1000, 1001, 1006])

export function isExpectedWebSocketClose(code: number): boolean {
  return expectedCloseCodes.has(code)
}

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
        if (!isExpectedWebSocketClose(code)) {
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
