import type { PublicStatusRuntimeSnapshot, PublicStatusSnapshot, SpotEvent } from '@iaxweb/contracts'
import { spotEventSchema, statusStreamMessageSchema } from '@iaxweb/contracts'
import { ReconnectingWebSocket } from './reconnecting-websocket'

interface StatusStreamOptions {
  onConnecting: () => void
  onExpired: () => void
  onInvalidMessage: () => void
  onOpen?: () => void
  onSnapshot: (snapshot: PublicStatusSnapshot) => void
  onSpot?: (spot: SpotEvent) => void
}

export class StatusStreamClient {
  private readonly connection: ReconnectingWebSocket
  private expired = false
  private fullSnapshot: PublicStatusSnapshot | undefined

  constructor(options: StatusStreamOptions) {
    this.connection = new ReconnectingWebSocket('/status', {
      delays: [1_000, 2_000, 4_000, 8_000, 16_000, 30_000],
      onDisconnect: (failures) => {
        this.fullSnapshot = undefined
        options.onConnecting()
        if (failures >= 5 && !this.expired) {
          this.expired = true
          options.onExpired()
        }
      },
      onMessage: event => this.handleMessage(event, options),
      ...(options.onOpen ? { onOpen: options.onOpen } : {}),
    })
  }

  start(): void {
    this.connection.start()
  }

  stop(): void {
    this.fullSnapshot = undefined
    this.connection.stop()
  }

  private handleMessage(event: MessageEvent<ArrayBuffer | string>, options: StatusStreamOptions): void {
    if (typeof event.data !== 'string') {
      options.onInvalidMessage()
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(event.data)
    }
    catch {
      options.onInvalidMessage()
      return
    }

    const spot = spotEventSchema.safeParse(parsed)
    if (spot.success && spot.data.type === 'spot') {
      this.markHealthy()
      options.onSpot?.(spot.data)
      return
    }

    const message = statusStreamMessageSchema.safeParse(parsed).data
    if (message?.type === 'snapshot')
      this.fullSnapshot = message.nodes
    const snapshot = message?.type === 'state'
      ? this.fullSnapshot && mergeRuntimeSnapshot(this.fullSnapshot, message.nodes)
      : message?.nodes
    if (!snapshot) {
      options.onInvalidMessage()
      return
    }

    this.markHealthy()
    options.onSnapshot(snapshot)
  }

  private markHealthy(): void {
    this.connection.markHealthy()
    this.expired = false
  }
}

export function markSnapshotOffline(snapshot: PublicStatusSnapshot): PublicStatusSnapshot {
  return Object.fromEntries(Object.entries(snapshot).map(([nodeId, node]) => [
    nodeId,
    {
      ...node,
      CONNS: {},
      LISTENERS: 0,
      ONLINE: false,
      TX_SOURCE: null,
    },
  ]))
}

function mergeRuntimeSnapshot(snapshot: PublicStatusSnapshot, runtime: PublicStatusRuntimeSnapshot): PublicStatusSnapshot | undefined {
  if (Object.keys(snapshot).length !== Object.keys(runtime).length)
    return

  const merged: PublicStatusSnapshot = {}
  for (const [nodeId, node] of Object.entries(snapshot)) {
    const state = runtime[nodeId]
    if (!state)
      return

    const { CONNS, LAST_TX_AT, LISTENERS, ONLINE, TX_SOURCE, ...metadata } = node
    merged[nodeId] = { ...metadata, ...state }
  }
  return merged
}
