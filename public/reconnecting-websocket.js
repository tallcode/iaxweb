export class ReconnectingWebSocket {
  constructor(path, options = {}) {
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
    this.socket = null
    this.timer = null
    this.failures = 0
    this.active = false
  }

  start() {
    if (this.active)
      return
    this.active = true
    this.connect()
  }

  stop(code = 1000, reason = 'Client stopped') {
    this.active = false
    if (this.timer !== null) {
      this.clearTimer(this.timer)
      this.timer = null
    }
    const socket = this.socket
    this.socket = null
    socket?.close(code, reason)
  }

  markHealthy() {
    this.failures = 0
  }

  connect() {
    if (!this.active)
      return

    const socket = this.createSocket(this.url())
    if (this.binaryType)
      socket.binaryType = this.binaryType
    this.socket = socket

    socket.addEventListener('open', () => this.onOpen())
    socket.addEventListener('message', event => this.onMessage(event))
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
