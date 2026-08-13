export interface SocketLike extends EventTarget {
  binaryType?: BinaryType
  close: (code?: number, reason?: string) => void
}

export interface ReconnectingWebSocketOptions {
  binaryType?: BinaryType
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
  createSocket?: (url: string) => SocketLike
  delays?: number[]
  maxFailures?: number
  onDisconnect?: (failures: number) => void
  onExhausted?: () => void
  onMessage?: (event: MessageEvent<ArrayBuffer | string>) => void
  onOpen?: () => void
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
  url?: () => string
}

export class ReconnectingWebSocket {
  private readonly binaryType: BinaryType | undefined
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void
  private readonly createSocket: (url: string) => SocketLike
  private readonly delays: number[]
  private readonly maxFailures: number
  private readonly onDisconnect: (failures: number) => void
  private readonly onExhausted: () => void
  private readonly onMessage: (event: MessageEvent<ArrayBuffer | string>) => void
  private readonly onOpen: () => void
  private readonly path: string
  private readonly setTimer: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
  private readonly url: () => string
  private active = false
  private failures = 0
  private socket: SocketLike | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(path: string, options: ReconnectingWebSocketOptions = {}) {
    this.path = path
    this.binaryType = options.binaryType
    this.delays = options.delays ?? [1_000, 2_000, 8_000, 30_000]
    this.maxFailures = options.maxFailures ?? Number.POSITIVE_INFINITY
    this.onOpen = options.onOpen ?? (() => {})
    this.onMessage = options.onMessage ?? (() => {})
    this.onDisconnect = options.onDisconnect ?? (() => {})
    this.onExhausted = options.onExhausted ?? (() => {})
    this.createSocket = options.createSocket ?? (url => new WebSocket(url))
    this.setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay))
    this.clearTimer = options.clearTimer ?? (timer => clearTimeout(timer))
    this.url = options.url ?? (() => {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      return `${protocol}//${location.host}${this.path}`
    })
  }

  start(): void {
    if (this.active)
      return
    this.active = true
    this.connect()
  }

  stop(code = 1000, reason = 'Client stopped'): void {
    this.active = false
    if (this.timer !== null) {
      this.clearTimer(this.timer)
      this.timer = null
    }
    const socket = this.socket
    this.socket = null
    socket?.close(code, reason)
  }

  markHealthy(): void {
    this.failures = 0
  }

  private connect(): void {
    if (!this.active)
      return

    const socket = this.createSocket(this.url())
    if (this.binaryType)
      socket.binaryType = this.binaryType
    this.socket = socket

    socket.addEventListener('open', () => this.onOpen())
    socket.addEventListener('message', event => this.onMessage(event as MessageEvent<ArrayBuffer | string>))
    socket.addEventListener('error', () => socket.close())
    socket.addEventListener('close', () => {
      if (this.socket === socket)
        this.socket = null
      if (!this.active)
        return

      this.failures++
      this.onDisconnect(this.failures)
      if (this.failures > this.maxFailures) {
        this.active = false
        this.onExhausted()
        return
      }

      const delay = this.delays[Math.min(this.failures - 1, this.delays.length - 1)] ?? 0
      this.timer = this.setTimer(() => {
        this.timer = null
        this.connect()
      }, delay)
    })
  }
}
