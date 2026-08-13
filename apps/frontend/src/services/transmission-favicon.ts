const REST_COLOR = '#16a34a'
const TX_COLOR = '#dc2626'
const PING_CYCLE_MS = 1_600
const FRAME_INTERVAL_MS = 300
const WAVE_COUNT = 2
const SIZE = 64
const CENTER = SIZE / 2
const DOT_RADIUS = 18
const MAX_RING_RADIUS = 30
const WAVE_LINE_WIDTH = 5

interface TransmissionFaviconOptions {
  cancelFrame?: (frame: ReturnType<typeof setTimeout>) => void
  canvas?: HTMLCanvasElement
  link?: HTMLLinkElement
  now?: () => number
  requestFrame?: (callback: () => void) => ReturnType<typeof setTimeout>
  setHref?: (href: string) => void
}

export class TransmissionFavicon {
  private animationStart = 0
  private readonly cancelFrame: (frame: ReturnType<typeof setTimeout>) => void
  private readonly canvas: HTMLCanvasElement
  private readonly context: CanvasRenderingContext2D
  private frame: ReturnType<typeof setTimeout> | undefined
  private link: HTMLLinkElement | undefined
  private readonly now: () => number
  private readonly requestFrame: (callback: () => void) => ReturnType<typeof setTimeout>
  private readonly setHref: (href: string) => void
  private transmitting = false

  constructor(options: TransmissionFaviconOptions = {}) {
    this.canvas = options.canvas ?? document.createElement('canvas')
    this.canvas.width = SIZE
    this.canvas.height = SIZE
    const context = this.canvas.getContext('2d')
    if (!context)
      throw new Error('Canvas 2D context is unavailable')
    this.context = context
    this.link = options.link
    this.setHref = options.setHref ?? ((href) => {
      if (!this.link) {
        this.link = document.createElement('link')
        this.link.rel = 'icon'
        document.head.append(this.link)
      }
      this.link.href = href
    })
    this.now = options.now ?? (() => performance.now())
    this.requestFrame = options.requestFrame ?? (callback => setTimeout(callback, FRAME_INTERVAL_MS))
    this.cancelFrame = options.cancelFrame ?? (frame => clearTimeout(frame))
    this.renderRest()
  }

  setTransmitting(transmitting: boolean): void {
    if (transmitting === this.transmitting)
      return
    this.transmitting = transmitting
    if (transmitting) {
      this.animationStart = this.now()
      this.tick()
    }
    else {
      if (this.frame !== undefined)
        this.cancelFrame(this.frame)
      this.frame = undefined
      this.renderRest()
    }
  }

  private renderRest(): void {
    this.draw()
    this.publish()
  }

  private tick(): void {
    this.frame = undefined
    this.draw()
    const progress = (this.now() - this.animationStart) % PING_CYCLE_MS / PING_CYCLE_MS
    for (let index = 0; index < WAVE_COUNT; index++) {
      const phase = (progress + index / WAVE_COUNT) % 1
      this.context.globalAlpha = (1 - phase) * 0.4
      this.context.beginPath()
      this.context.arc(CENTER, CENTER, DOT_RADIUS + phase * (MAX_RING_RADIUS - DOT_RADIUS), 0, Math.PI * 2)
      this.context.strokeStyle = TX_COLOR
      this.context.lineWidth = WAVE_LINE_WIDTH
      this.context.stroke()
    }
    this.context.globalAlpha = 1
    this.publish()
    if (this.transmitting)
      this.frame = this.requestFrame(() => this.tick())
  }

  private draw(): void {
    this.context.clearRect(0, 0, SIZE, SIZE)
    this.context.beginPath()
    this.context.arc(CENTER, CENTER, DOT_RADIUS, 0, Math.PI * 2)
    this.context.fillStyle = this.transmitting ? TX_COLOR : REST_COLOR
    this.context.fill()
  }

  private publish(): void {
    this.setHref(this.canvas.toDataURL('image/png'))
  }
}
