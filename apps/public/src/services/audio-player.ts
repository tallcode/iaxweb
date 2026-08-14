import { ReconnectingWebSocket } from './reconnecting-websocket'

const SAMPLE_RATE = 8_000
const JITTER_SECONDS = 0.1
const SPECTRUM_BARS = 28

interface AudioLabels {
  play: string
  stop: string
}

interface PlaybackBinding {
  button: HTMLButtonElement
  nodeId: string
  labels: AudioLabels
  spectrumMeter: SpectrumMeter
}

export class AudioStreamPlayer {
  private analyser: AnalyserNode | null = null
  private baseAudioTime = 0
  private baseTimestamp: number | null = null
  private binding: PlaybackBinding | null = null
  private connection: ReconnectingWebSocket | null = null
  private context: AudioContext | null = null
  private lastTimestamp: number | null = null

  get playingNodeId(): string | null {
    return this.binding?.nodeId ?? null
  }

  async toggle(
    nodeId: string,
    button: HTMLButtonElement,
    spectrumMeter: SpectrumMeter,
    labels: AudioLabels = { play: '播放', stop: '停止' },
  ): Promise<void> {
    if (this.context && this.playingNodeId === nodeId) {
      await this.stop()
      return
    }
    if (this.context)
      await this.stop()
    await this.start(nodeId, button, spectrumMeter, labels)
  }

  async start(nodeId: string, button: HTMLButtonElement, spectrumMeter: SpectrumMeter, labels: AudioLabels): Promise<void> {
    const context = new AudioContext({ sampleRate: SAMPLE_RATE })
    this.context = context
    try {
      await context.resume()
    }
    catch (error) {
      this.context = null
      await context.close()
      throw error
    }
    this.binding = { button, labels, nodeId, spectrumMeter }
    this.setVisualizationEnabled()
    this.resetTimeline()
    this.setPlaying(true)
    this.connection = new ReconnectingWebSocket(`/audio/${encodeURIComponent(nodeId)}`, {
      binaryType: 'arraybuffer',
      delays: [1_000, 2_000, 8_000, 32_000],
      maxFailures: 4,
      onDisconnect: () => this.resetTimeline(),
      onExhausted: () => void this.stop(false),
      onMessage: event => this.handleMessage(event),
    })
    this.connection.start()
  }

  async stop(closeSocket = true): Promise<void> {
    const connection = this.connection
    this.connection = null
    if (closeSocket)
      connection?.stop(1000, 'Playback stopped')

    const binding = this.binding
    this.binding = null
    binding?.spectrumMeter.detach()
    this.analyser = null

    const context = this.context
    this.context = null
    this.resetTimeline()
    await context?.close()
    this.setBindingPlaying(binding, false)
  }

  setVisualizationEnabled(enabled = this.binding?.spectrumMeter.enabled ?? false): void {
    const binding = this.binding
    const context = this.context
    if (!binding || !context)
      return

    if (!enabled || !binding.spectrumMeter.enabled) {
      binding.spectrumMeter.detach()
      this.analyser?.disconnect()
      this.analyser = null
      return
    }
    if (this.analyser)
      return

    const analyser = context.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.7
    analyser.connect(context.destination)
    this.analyser = analyser
    binding.spectrumMeter.attach(analyser)
  }

  private handleMessage(event: MessageEvent<ArrayBuffer | string>): void {
    if (typeof event.data === 'string') {
      try {
        const message = JSON.parse(event.data) as Record<string, unknown>
        if (message.type !== 'state' || typeof message.online !== 'boolean')
          return
        this.connection?.markHealthy()
        if (!message.online)
          this.resetTimeline()
      }
      catch {
        // Unknown control messages do not interrupt audio playback.
      }
      return
    }

    if (this.scheduleFrame(event.data))
      this.connection?.markHealthy()
  }

  private scheduleFrame(data: ArrayBuffer): boolean {
    const context = this.context
    if (!context || data.byteLength < 11)
      return false
    const view = new DataView(data)
    if (view.getUint8(0) !== 1 || view.getUint8(1) !== 1)
      return false

    const timestamp = view.getUint32(6, false)
    if (this.lastTimestamp !== null && signedDifference(timestamp, this.lastTimestamp) < -1_000)
      this.resetTimeline()
    if (this.baseTimestamp === null) {
      this.baseTimestamp = timestamp
      this.baseAudioTime = context.currentTime + JITTER_SECONDS
    }

    let startTime = this.baseAudioTime + unsignedDifference(timestamp, this.baseTimestamp) / 1_000
    if (startTime < context.currentTime - 0.05) {
      this.baseTimestamp = timestamp
      this.baseAudioTime = context.currentTime + JITTER_SECONDS
      startTime = this.baseAudioTime
    }

    const encoded = new Uint8Array(data, 10)
    const buffer = context.createBuffer(1, encoded.length, SAMPLE_RATE)
    const samples = buffer.getChannelData(0)
    encoded.forEach((value, index) => samples[index] = decodeMuLaw(value))
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(this.analyser ?? context.destination)
    source.start(Math.max(startTime, context.currentTime))
    this.lastTimestamp = timestamp
    return true
  }

  private resetTimeline(): void {
    this.baseTimestamp = null
    this.baseAudioTime = 0
    this.lastTimestamp = null
  }

  private setPlaying(playing: boolean): void {
    this.setBindingPlaying(this.binding, playing)
  }

  private setBindingPlaying(binding: PlaybackBinding | null, playing: boolean): void {
    if (!binding)
      return
    binding.spectrumMeter.setPlaying(playing)
    binding.button.textContent = playing ? binding.labels.stop : binding.labels.play
    binding.button.setAttribute('aria-label', playing ? '停止播放' : '播放音频')
    binding.button.setAttribute('aria-pressed', String(playing))
  }
}

export class SpectrumMeter {
  private analyser: AnalyserNode | null = null
  private readonly bars: HTMLSpanElement[] = []
  private frame = 0
  private freqData: Uint8Array<ArrayBuffer> | null = null
  private readonly levelFill: HTMLElement | null
  private readonly levelPeak: HTMLElement | null
  private peak = 0
  private readonly rootElement: HTMLElement
  private readonly shouldEnable: () => boolean
  private readonly spectrum: HTMLElement
  private timeData: Uint8Array<ArrayBuffer> | null = null

  constructor(rootElement: HTMLElement, options: { enabled?: () => boolean } = {}) {
    this.rootElement = rootElement
    this.shouldEnable = options.enabled ?? (() => true)
    const spectrum = rootElement.querySelector<HTMLElement>('.spectrum')
    if (!spectrum)
      throw new Error('Spectrum meter requires a .spectrum element')
    this.spectrum = spectrum
    this.levelFill = rootElement.querySelector('.level-fill')
    this.levelPeak = rootElement.querySelector('.level-peak')
    this.render = this.render.bind(this)
    this.reset()
  }

  get enabled(): boolean {
    return this.shouldEnable()
  }

  attach(analyser: AnalyserNode): void {
    if (!this.enabled)
      return
    this.ensureBars()
    this.analyser = analyser
    this.timeData = new Uint8Array(analyser.fftSize)
    this.freqData = new Uint8Array(analyser.frequencyBinCount)
    if (!this.frame)
      this.frame = requestAnimationFrame(this.render)
  }

  setPlaying(playing: boolean): void {
    this.rootElement.classList.toggle('is-playing', playing)
  }

  detach(): void {
    if (this.frame) {
      cancelAnimationFrame(this.frame)
      this.frame = 0
    }
    this.analyser = null
    this.peak = 0
    this.reset()
  }

  private ensureBars(): void {
    if (this.bars.length > 0)
      return
    for (let index = 0; index < SPECTRUM_BARS; index++) {
      const bar = document.createElement('span')
      bar.className = 'bar'
      this.spectrum.append(bar)
      this.bars.push(bar)
    }
  }

  private reset(): void {
    for (const bar of this.bars)
      bar.style.transform = 'scaleY(0.02)'
    if (this.levelFill)
      this.levelFill.style.transform = 'scaleX(0)'
    if (this.levelPeak)
      this.levelPeak.style.left = '0%'
  }

  private render(): void {
    const analyser = this.analyser
    const timeData = this.timeData
    const freqData = this.freqData
    if (!analyser || !timeData || !freqData)
      return
    this.frame = requestAnimationFrame(this.render)

    if (this.levelFill && this.levelPeak) {
      analyser.getByteTimeDomainData(timeData)
      const sumSquares = timeData.reduce((sum, value) => {
        const sample = (value - 128) / 128
        return sum + sample * sample
      }, 0)
      const rms = Math.sqrt(sumSquares / timeData.length)
      const dbfs = rms > 0 ? 20 * Math.log10(rms) : Number.NEGATIVE_INFINITY
      const level = Number.isFinite(dbfs) ? Math.max(0, Math.min(1, (dbfs + 60) / 60)) : 0
      this.levelFill.style.transform = `scaleX(${level})`
      this.peak = Math.max(level, this.peak - 0.01)
      this.levelPeak.style.left = `${this.peak * 100}%`
    }

    analyser.getByteFrequencyData(freqData)
    const usableBins = Math.floor(freqData.length * 0.85)
    this.bars.forEach((bar, index) => {
      const start = Math.floor((index / this.bars.length) * usableBins)
      const end = Math.max(start + 1, Math.floor(((index + 1) / this.bars.length) * usableBins))
      let sum = 0
      for (let bin = start; bin < end; bin++)
        sum += freqData[bin] ?? 0
      bar.style.transform = `scaleY(${Math.max(0.02, sum / (end - start) / 255)})`
    })
  }
}

function unsignedDifference(current: number, base: number): number {
  return (current - base) >>> 0
}

function signedDifference(current: number, previous: number): number {
  return (current - previous) | 0
}

function decodeMuLaw(value: number): number {
  const muLaw = (~value) & 0xFF
  const sign = muLaw & 0x80
  const exponent = (muLaw >> 4) & 0x07
  const mantissa = muLaw & 0x0F
  const sample = (((mantissa << 3) + 0x84) << exponent) - 0x84
  return (sign ? -sample : sample) / 32_768
}
