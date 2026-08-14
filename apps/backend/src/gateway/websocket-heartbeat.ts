import type { WebSocket, WebSocketServer } from 'ws'

// Browsers commonly produce 1005/1006 when a tab reloads/closes or the
// network disappears before a proper close handshake completes (1005 = a
// close frame arrived with no status code, 1006 = no close frame at all).
// Reconnect logic lives on the client, so this is expected transport churn
// rather than a server error.
const expectedCloseCodes = new Set([1000, 1001, 1005, 1006])

export function isExpectedWebSocketClose(code: number): boolean {
  return expectedCloseCodes.has(code)
}

export function startWebSocketHeartbeat(
  server: WebSocketServer,
  intervalMs = 25_000,
): () => void {
  const responsiveClients = new WeakSet<WebSocket>()

  server.on('connection', (client, request) => {
    responsiveClients.add(client)
    client.on('pong', () => responsiveClients.add(client))
    client.on('close', (code, reason) => {
      if (!isExpectedWebSocketClose(code)) {
        const address = request.socket.remoteAddress ?? 'unknown'
        const detail = reason.length > 0 ? `: ${reason.toString()}` : ''
        console.warn(`${webSocketName(request.url)} WebSocket closed unexpectedly (${address}, code ${code}${detail})`)
      }
    })
  })

  const timer = setInterval(() => {
    for (const client of server.clients) {
      if (client.readyState !== client.OPEN)
        continue

      if (!responsiveClients.has(client)) {
        client.terminate()
        continue
      }

      responsiveClients.delete(client)
      client.ping()
    }
  }, intervalMs)
  timer.unref()

  return () => clearInterval(timer)
}

function webSocketName(url: string | undefined): string {
  return url?.startsWith('/audio/') ? 'Audio' : 'Status'
}
