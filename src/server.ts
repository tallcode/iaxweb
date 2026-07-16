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
import { Allmon3StatusService, parseNodeDefinitions } from './allmon3.js'
import { loadConfig } from './config.js'
import { NatsAudioService } from './nats-audio.js'

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
const allmon3 = new Allmon3StatusService({
  ...config.allmon3,
  nodes: nodeDefinitions,
  onChange: publishAllmon3Status,
})
const natsAudio = new NatsAudioService({
  config: config.nats,
  onAudio: data => broadcastAudio(data, true),
  onEvent: text => broadcastAudio(text, false),
  onState: state => broadcastAudio(JSON.stringify(state), false),
})

httpServer.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', 'http://localhost')
  const server = url.pathname === '/audio'
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

audioWebSockets.on('connection', (client) => {
  client.send(JSON.stringify(natsAudio.currentState))
})

statusWebSockets.on('connection', (client) => {
  const snapshot = allmon3.currentSnapshot
  if (snapshot)
    client.send(JSON.stringify(snapshot))
})

function main(): void {
  allmon3.start()
  natsAudio.start()

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
      nats: natsAudio.connected,
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

function broadcastAudio(data: Uint8Array | string, binary: boolean): void {
  for (const client of audioWebSockets.clients) {
    if (client.readyState !== client.OPEN)
      continue

    // Real-time audio is more useful dropped than delivered late.
    if (binary && client.bufferedAmount > 4 * 1024)
      continue

    client.send(data, { binary })
  }
}

function publishAllmon3Status(snapshot: StatusSnapshot): void {
  const message = JSON.stringify(snapshot)
  // console.log(message)
  for (const client of statusWebSockets.clients) {
    if (client.readyState === client.OPEN)
      client.send(message)
  }
}

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}, shutting down`)
  allmon3.stop()
  audioWebSockets.clients.forEach((client: WebSocket) => client.close(1001, 'Server shutting down'))
  statusWebSockets.clients.forEach((client: WebSocket) => client.close(1001, 'Server shutting down'))
  audioWebSockets.close()
  statusWebSockets.close()
  await new Promise<void>(resolveClose => httpServer.close(() => resolveClose()))
  await natsAudio.stop()
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(signal).finally(() => process.exit(0))
  })
}

main()
