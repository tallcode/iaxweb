import type { NatsConnection, Subscription } from '@nats-io/transport-node'

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebSocket } from 'ws'
import type { StatusSnapshot } from './allmon3.js'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

import { createServer } from 'node:http'
import { dirname, extname, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { connect, RequestError, TimeoutError } from '@nats-io/transport-node'
import { config as loadEnv } from 'dotenv'
import { WebSocketServer } from 'ws'
import { Allmon3StatusService, parseNodeDefinitions } from './allmon3.js'
import { loadConfig } from './config.js'

interface StateEvent {
  type: 'state'
  online: boolean
  speaking: boolean
}

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

let latestState: StateEvent = { type: 'state', online: false, speaking: false }
let nats: NatsConnection

const httpServer = createServer(serveHttp)
const audioWebSockets = new WebSocketServer({ noServer: true })
const statusWebSockets = new WebSocketServer({ noServer: true })
const allmon3 = new Allmon3StatusService({
  ...config.allmon3,
  nodes: nodeDefinitions,
  onChange: publishAllmon3Status,
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
  client.send(JSON.stringify(latestState))
})

statusWebSockets.on('connection', (client) => {
  const snapshot = allmon3.currentSnapshot
  if (snapshot)
    client.send(JSON.stringify(snapshot))
})

const prefix = config.nats.subjectPrefix

async function main(): Promise<void> {
  nats = await connect({
    servers: config.nats.servers,
    ...(config.nats.username
      ? { user: config.nats.username, pass: config.nats.password }
      : {}),
    ...(config.nats.token ? { token: config.nats.token } : {}),
    name: 'iaxweb',
    maxReconnectAttempts: -1,
  })

  const audioSubscription = nats.subscribe(`${prefix}.audio`)
  const eventSubscription = nats.subscribe(`${prefix}.events`)
  void relayAudio(audioSubscription)
  void relayEvents(eventSubscription)
  void logNatsStatus(nats)

  await nats.flush()
  await requestSnapshot(nats)
  allmon3.start()

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
      nats: !nats.isClosed(),
      ok: true,
    }))
    return
  }

  const pathname = url.pathname === '/'
    ? '/index.html'
    : ['/map', '/map/'].includes(url.pathname)
        ? '/map.html'
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

async function relayAudio(subscription: Subscription): Promise<void> {
  for await (const message of subscription)
    broadcastAudio(message.data, true)
}

async function relayEvents(subscription: Subscription): Promise<void> {
  for await (const message of subscription) {
    const text = new TextDecoder().decode(message.data)
    try {
      const event = JSON.parse(text) as unknown
      if (isStateEvent(event))
        latestState = event
      broadcastAudio(text, false)
    }
    catch (error) {
      console.warn('Ignoring invalid NATS event:', error)
    }
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
  console.log(message)
  for (const client of statusWebSockets.clients) {
    if (client.readyState === client.OPEN)
      client.send(message)
  }
}

async function requestSnapshot(connection: NatsConnection): Promise<void> {
  try {
    const reply = await connection.request(`${prefix}.snapshot`, undefined, { timeout: 2_000 })
    const state = JSON.parse(new TextDecoder().decode(reply.data)) as unknown
    if (isStateEvent(state))
      latestState = state
  }
  catch (error) {
    if ((error instanceof RequestError && error.isNoResponders()) || error instanceof TimeoutError) {
      console.warn(`NATS snapshot responder is unavailable on ${prefix}.snapshot; continuing offline`)
      return
    }

    console.warn('Failed to read NATS state snapshot:', error)
  }
}

function isStateEvent(value: unknown): value is StateEvent {
  if (typeof value !== 'object' || value === null)
    return false
  const event = value as Record<string, unknown>
  return event.type === 'state'
    && typeof event.online === 'boolean'
    && typeof event.speaking === 'boolean'
}

async function logNatsStatus(connection: NatsConnection): Promise<void> {
  for await (const status of connection.status()) {
    console.log(`NATS ${status.type}`, status)

    if (status.type === 'disconnect') {
      latestState = { type: 'state', online: false, speaking: false }
      broadcastAudio(JSON.stringify(latestState), false)
    }
    else if (status.type === 'reconnect') {
      await requestSnapshot(connection)
      broadcastAudio(JSON.stringify(latestState), false)
    }
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
  await nats.drain()
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(signal).finally(() => process.exit(0))
  })
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
