// Live status favicon: a green dot at rest, a pulsing red dot (Tailwind
// animate-ping style) while a repeater transmits. Rendered on a 2x canvas so
// the icon stays crisp when the browser scales it down for the tab.
//
// The pulse loop is driven by setTimeout instead of requestAnimationFrame:
// rAF is suspended in background tabs, which is exactly when users watch the
// favicon, so the transmission state must paint without it. Timers keep
// running in background tabs (Chrome throttles them to >=1s, fine for a
// pulse) and the low frame rate also keeps Chrome from discarding rapid
// favicon updates.
const REST_COLOR = '#16a34a'
const TX_COLOR = '#dc2626'
const PING_CYCLE_MS = 1600
const FRAME_INTERVAL_MS = 300
const WAVE_COUNT = 2
const SIZE = 64
const CENTER = SIZE / 2
// The page's online/offline legend dots are 0.55rem (~8.8px). Tabs render the
// favicon at ~16px, so a dot radius of 18/64 yields a ~9px dot on screen —
// the same visual size as the legend indicator.
const DOT_RADIUS = 18
const MAX_RING_RADIUS = 30
const WAVE_LINE_WIDTH = 5

export class TransmissionFavicon {
  constructor(options = {}) {
    this.canvas = options.canvas ?? document.createElement('canvas')
    this.canvas.width = SIZE
    this.canvas.height = SIZE
    this.context = this.canvas.getContext('2d')
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
    this.transmitting = false
    this.animationStart = undefined
    this.frame = undefined
    this.renderRest()
  }

  setTransmitting(transmitting) {
    if (transmitting === this.transmitting)
      return
    this.transmitting = transmitting
    if (transmitting) {
      this.animationStart = this.now()
      // Paint the red dot synchronously so the tab changes color even when
      // timers are throttled, then keep the pulse loop going.
      this.tick()
    }
    else {
      this.cancelFrame(this.frame)
      this.frame = undefined
      this.renderRest()
    }
  }

  renderRest() {
    this.draw()
    this.publish()
  }

  tick() {
    this.frame = undefined
    this.draw()
    const progress = (this.now() - this.animationStart) % PING_CYCLE_MS / PING_CYCLE_MS
    const ctx = this.context
    for (let i = 0; i < WAVE_COUNT; i++) {
      const phase = (progress + i / WAVE_COUNT) % 1
      ctx.globalAlpha = (1 - phase) * 0.4
      ctx.beginPath()
      ctx.arc(CENTER, CENTER, DOT_RADIUS + phase * (MAX_RING_RADIUS - DOT_RADIUS), 0, Math.PI * 2)
      ctx.strokeStyle = TX_COLOR
      ctx.lineWidth = WAVE_LINE_WIDTH
      ctx.stroke()
    }
    ctx.globalAlpha = 1
    this.publish()
    if (this.transmitting)
      this.frame = this.requestFrame(() => this.tick())
  }

  draw() {
    const ctx = this.context
    ctx.clearRect(0, 0, SIZE, SIZE)
    ctx.beginPath()
    ctx.arc(CENTER, CENTER, DOT_RADIUS, 0, Math.PI * 2)
    ctx.fillStyle = this.transmitting ? TX_COLOR : REST_COLOR
    ctx.fill()
  }

  publish() {
    this.setHref(this.canvas.toDataURL('image/png'))
  }
}
