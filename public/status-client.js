import { ReconnectingWebSocket } from './reconnecting-websocket.js'

export class StatusStreamClient {
  constructor(options) {
    this.onSnapshot = options.onSnapshot
    this.onConnecting = options.onConnecting
    this.onInvalidMessage = options.onInvalidMessage
    this.onExpired = options.onExpired
    this.expired = false
    this.connection = new ReconnectingWebSocket('/status', {
      delays: [1_000, 2_000, 4_000, 8_000, 16_000, 30_000],
      onDisconnect: (failures) => {
        this.onConnecting()
        if (failures >= 5 && !this.expired) {
          this.expired = true
          this.onExpired()
        }
      },
      onMessage: event => this.handleMessage(event),
      onOpen: options.onOpen,
    })
  }

  start() {
    this.connection.start()
  }

  stop() {
    this.connection.stop()
  }

  handleMessage(event) {
    try {
      const snapshot = JSON.parse(event.data)
      if (!isSnapshot(snapshot))
        throw new Error('status payload is not an object')
      this.connection.markHealthy()
      this.expired = false
      this.onSnapshot(snapshot)
    }
    catch {
      this.onInvalidMessage()
    }
  }
}

export function expireSnapshot(snapshot) {
  return Object.fromEntries(Object.entries(snapshot).map(([nodeId, node]) => [
    nodeId,
    {
      ...node,
      CONNKEYED: false,
      CONNKEYEDNODE: false,
      CONNS: {},
      ERROR: 'Status WebSocket disconnected',
      LISTENERS: 0,
      ONLINE: false,
      RXKEYED: false,
      TXEKEYED: false,
      TXKEYED: false,
      TX_SOURCE: null,
    },
  ]))
}

function isSnapshot(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
