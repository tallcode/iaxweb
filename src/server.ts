import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebSocket } from 'ws'
import type { StatusSnapshot } from './allmon3.js'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

import { createServer } from 'node:http'
import { dirname, extname, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'
import { WebSocketServer } from 'ws'
import { Allmon3StatusService, parseNodeDefinitions, publicStatusSnapshot } from './allmon3.js'
import { loadConfig } from './config.js'
import { NatsAudioService } from './nats-audio.js'
import { startWebSocketHeartbeat } from './websocket-heartbeat.js'

loadEnv({ quiet: true })
const config = loadConfig()
const publicRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../public')
const nodesPath = resolve(dirname(fileURLToPath(import.meta.url)), '../nodes.json')
const nodeDefinitions = parseNodeDefinitions(JSON.parse(readFileSync(nodesPath, 'utf8')) as unknown)
const mimeTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
}

const httpServer = createServer(serveHttp)
const audioWebSockets = new WebSocketServer({ noServer: true })
const statusWebSockets = new WebSocketServer({ noServer: true })
const audioClientNodes = new WeakMap<WebSocket, string>()
const audioListeners = new Map<string, number>()
const stopWebSocketHeartbeat = startWebSocketHeartbeat([
  { name: 'Audio', server: audioWebSockets },
  { name: 'Status', server: statusWebSockets },
])
const allmon3 = new Allmon3StatusService({
  ...config.allmon3,
  nodes: nodeDefinitions,
  onChange: publishAllmon3Status,
})
const natsAudio = new Map<string, NatsAudioService>()
for (const [nodeId, definition] of Object.entries(nodeDefinitions)) {
  if (definition.AUDIO !== true)
    continue
  audioListeners.set(nodeId, 0)
  natsAudio.set(nodeId, new NatsAudioService({
    config: config.nats,
    nodeId,
    onAudio: data => broadcastAudio(nodeId, data, true),
    onEvent: text => broadcastAudio(nodeId, text, false),
    onState: state => publishAudioState(nodeId, state),
  }))
}

httpServer.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', 'http://localhost')
  const audioNode = audioNodeFromPath(url.pathname)
  const server = audioNode && natsAudio.has(audioNode)
    ? audioWebSockets
    : url.pathname === '/status'
      ? statusWebSockets
      : undefined
  if (!server) {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }

  server.handleUpgrade(request, socket, head, (client) => {
    server.emit('connection', client, request)
  })
})

audioWebSockets.on('connection', (client, request) => {
  // The upgrade path validates this parameter before accepting the socket.
  const nodeId = audioNodeFromPath(new URL(request.url ?? '/', 'http://localhost').pathname)
  const service = nodeId ? natsAudio.get(nodeId) : undefined
  if (!nodeId || !service) {
    client.close(1008, 'Unknown audio node')
    return
  }
  audioClientNodes.set(client, nodeId)
  updateAudioListenerCount(nodeId)
  client.send(JSON.stringify(service.currentState))
  client.once('close', () => updateAudioListenerCount(nodeId))
})

function audioNodeFromPath(pathname: string): string | undefined {
  const match = /^\/audio\/([^/]+)$/.exec(pathname)
  return match?.[1]
}

statusWebSockets.on('connection', (client) => {
  const snapshot = allmon3.currentSnapshot
  if (snapshot)
    client.send(JSON.stringify(publicStatusSnapshot(snapshot, audioListeners)))
})

function main(): void {
  allmon3.start()
  for (const service of natsAudio.values())
    service.start()

  httpServer.listen(config.port, config.host, () => {
    console.log(`iaxweb listening on http://${config.host}:${config.port}`)
  })
}

async function serveHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost')
  if (url.pathname === '/healthz') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({
      allmon3: Boolean(allmon3.currentSnapshot),
      nats: natsAudio.size > 0 && [...natsAudio.values()].every(service => service.connected),
      ok: true,
    }))
    return
  }

  const pathname = url.pathname === '/'
    ? '/index.html'
    : ['/map', '/map/'].includes(url.pathname)
        ? '/index.html'
        : url.pathname
  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(pathname)
  }
  catch {
    response.writeHead(400).end('Bad Request')
    return
  }

  const filePath = resolve(publicRoot, `.${decodedPath}`)
  if (!filePath.startsWith(`${publicRoot}${sep}`)) {
    response.writeHead(404).end('Not Found')
    return
  }

  try {
    const body = await readFile(filePath)
    response.writeHead(200, {
      'cache-control': 'no-cache',
      'content-type': mimeTypes[extname(filePath)] ?? 'application/octet-stream',
    })
    response.end(request.method === 'HEAD' ? undefined : body)
  }
  catch {
    response.writeHead(404).end('Not Found')
  }
}

function broadcastAudio(nodeId: string, data: Uint8Array | string, binary: boolean): void {
  for (const client of audioWebSockets.clients) {
    if (client.readyState !== client.OPEN || audioClientNodes.get(client) !== nodeId)
      continue

    // Real-time audio is more useful dropped than delivered late.
    if (binary && client.bufferedAmount > 4 * 1024)
      continue

    client.send(data, { binary })
  }
}

function updateAudioListenerCount(nodeId: string): void {
  let count = 0
  for (const client of audioWebSockets.clients) {
    if (client.readyState === client.OPEN && audioClientNodes.get(client) === nodeId)
      count++
  }
  natsAudio.get(nodeId)?.setListenerCount(count)
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
  // console.log(message)
  for (const client of statusWebSockets.clients) {
    if (client.readyState === client.OPEN)
      client.send(message)
  }
}

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}, shutting down`)
  allmon3.stop()
  stopWebSocketHeartbeat()
  audioWebSockets.clients.forEach((client: WebSocket) => client.close(1001, 'Server shutting down'))
  statusWebSockets.clients.forEach((client: WebSocket) => client.close(1001, 'Server shutting down'))
  audioWebSockets.close()
  statusWebSockets.close()
  await new Promise<void>(resolveClose => httpServer.close(() => resolveClose()))
  await Promise.all([...natsAudio.values()].map(service => service.stop()))
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(signal).finally(() => process.exit(0))
  })
}

main()
