import type { PublicStatusSnapshot, SpotEvent } from '@iaxweb/contracts'
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

  constructor(options: StatusStreamOptions) {
    this.connection = new ReconnectingWebSocket('/status', {
      delays: [1_000, 2_000, 4_000, 8_000, 16_000, 30_000],
      onDisconnect: (failures) => {
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

    if (isSpot(parsed)) {
      this.connection.markHealthy()
      this.expired = false
      options.onSpot?.(parsed)
    }
    else if (isSnapshot(parsed)) {
      this.connection.markHealthy()
      this.expired = false
      options.onSnapshot(parsed)
    }
    else {
      options.onInvalidMessage()
    }
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

function isSnapshot(value: unknown): value is PublicStatusSnapshot {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSpot(value: unknown): value is SpotEvent {
  if (typeof value !== 'object' || value === null)
    return false
  const spot = value as Record<string, unknown>
  return spot.type === 'spot'
    && typeof spot.at === 'string'
    && typeof spot.callsign === 'string'
    && typeof spot.id === 'string'
    && typeof spot.node === 'string'
}
