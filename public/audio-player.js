import { ReconnectingWebSocket } from './reconnecting-websocket.js'

const SAMPLE_RATE = 8_000
const JITTER_SECONDS = 0.1
const SPECTRUM_BARS = 28

export class AudioStreamPlayer {
  constructor() {
    this.binding = null
    this.connection = null
    this.context = null
    this.analyser = null
    this.baseTimestamp = null
    this.baseAudioTime = 0
    this.lastTimestamp = null
  }

  get playingKey() {
    return this.binding?.key ?? null
  }

  async toggle(key, button, meter, labels = { play: '播放', stop: '停止' }) {
    if (this.context && this.playingKey === key) {
      await this.stop()
      return
    }
    if (this.context)
      await this.stop()
    await this.start(key, button, meter, labels)
  }

  async start(key, button, meter, labels = { play: '播放', stop: '停止' }) {
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
    this.binding = { button, key, labels, meter }

    const analyser = context.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.7
    analyser.connect(context.destination)
    this.analyser = analyser
    meter.attach(analyser)

    this.resetTimeline()
    this.setPlaying(true)
    this.connection = new ReconnectingWebSocket(`/audio/${encodeURIComponent(key)}`, {
      binaryType: 'arraybuffer',
      delays: [1_000, 2_000, 8_000, 32_000],
      maxFailures: 4,
      onDisconnect: () => this.resetTimeline(),
      onExhausted: () => void this.stop(false),
      onMessage: event => this.handleMessage(event),
    })
    this.connection.start()
  }

  async stop(closeSocket = true) {
    const connection = this.connection
    this.connection = null
    if (closeSocket)
      connection?.stop(1000, 'Playback stopped')

    const binding = this.binding
    this.binding = null
    binding?.meter.detach()
    this.analyser = null

    const context = this.context
    this.context = null
    this.resetTimeline()
    await context?.close()
    this.setBindingPlaying(binding, false)
  }

  handleMessage(event) {
    if (typeof event.data === 'string') {
      try {
        const message = JSON.parse(event.data)
        if (message.type !== 'state' || typeof message.online !== 'boolean')
          return
        this.connection?.markHealthy()
        if (message.online === false)
          this.resetTimeline()
      }
      catch {
        // Ignore unknown control messages; audio can continue independently.
      }
      return
    }

    if (this.scheduleFrame(event.data))
      this.connection?.markHealthy()
  }

  scheduleFrame(data) {
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
    for (let index = 0; index < encoded.length; index++)
      samples[index] = decodeMuLaw(encoded[index])

    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(this.analyser ?? context.destination)
    source.start(Math.max(startTime, context.currentTime))
    this.lastTimestamp = timestamp
    return true
  }

  resetTimeline() {
    this.baseTimestamp = null
    this.baseAudioTime = 0
    this.lastTimestamp = null
  }

  setPlaying(playing) {
    this.setBindingPlaying(this.binding, playing)
  }

  setBindingPlaying(binding, playing) {
    if (!binding)
      return
    binding.meter.setPlaying?.(playing)
    binding.button.textContent = playing ? binding.labels.stop : binding.labels.play
    binding.button.setAttribute('aria-label', playing ? '停止播放' : '播放音频')
    binding.button.setAttribute('aria-pressed', String(playing))
  }
}

export class SpectrumMeter {
  constructor(root) {
    this.root = root
    this.spectrum = root.querySelector('.spectrum')
    this.levelFill = root.querySelector('.level-fill')
    this.levelPeak = root.querySelector('.level-peak')

    this.bars = []
    for (let index = 0; index < SPECTRUM_BARS; index++) {
      const bar = document.createElement('span')
      bar.className = 'bar'
      this.spectrum.append(bar)
      this.bars.push(bar)
    }

    this.analyser = null
    this.timeData = null
    this.freqData = null
    this.frame = 0
    this.peak = 0
    this.render = this.render.bind(this)
    this.reset()
  }

  attach(analyser) {
    this.analyser = analyser
    this.timeData = new Uint8Array(analyser.fftSize)
    this.freqData = new Uint8Array(analyser.frequencyBinCount)
    if (!this.frame)
      this.frame = requestAnimationFrame(this.render)
  }

  setPlaying(playing) {
    this.root.classList?.toggle('is-playing', playing)
  }

  detach() {
    if (this.frame) {
      cancelAnimationFrame(this.frame)
      this.frame = 0
    }
    this.analyser = null
    this.peak = 0
    this.reset()
  }

  reset() {
    for (const bar of this.bars)
      bar.style.transform = 'scaleY(0.02)'
    if (this.levelFill)
      this.levelFill.style.transform = 'scaleX(0)'
    if (this.levelPeak)
      this.levelPeak.style.left = '0%'
  }

  render() {
    const analyser = this.analyser
    if (!analyser)
      return

    this.frame = requestAnimationFrame(this.render)
    if (this.levelFill && this.levelPeak) {
      analyser.getByteTimeDomainData(this.timeData)
      let sumSquares = 0
      for (const value of this.timeData) {
        const sample = (value - 128) / 128
        sumSquares += sample * sample
      }
      const rms = Math.sqrt(sumSquares / this.timeData.length)
      const dbfs = rms > 0 ? 20 * Math.log10(rms) : Number.NEGATIVE_INFINITY
      const level = Number.isFinite(dbfs) ? Math.max(0, Math.min(1, (dbfs + 60) / 60)) : 0

      this.levelFill.style.transform = `scaleX(${level})`
      this.peak = Math.max(level, this.peak - 0.01)
      this.levelPeak.style.left = `${this.peak * 100}%`
    }

    analyser.getByteFrequencyData(this.freqData)
    const usableBins = Math.floor(this.freqData.length * 0.85)
    for (let index = 0; index < this.bars.length; index++) {
      const start = Math.floor((index / this.bars.length) * usableBins)
      const end = Math.max(start + 1, Math.floor(((index + 1) / this.bars.length) * usableBins))
      let sum = 0
      for (let bin = start; bin < end; bin++)
        sum += this.freqData[bin]
      const magnitude = sum / (end - start) / 255
      this.bars[index].style.transform = `scaleY(${Math.max(0.02, magnitude)})`
    }
  }
}

function unsignedDifference(current, base) {
  return (current - base) >>> 0
}

function signedDifference(current, previous) {
  return (current - previous) | 0
}

function decodeMuLaw(value) {
  const muLaw = (~value) & 0xFF
  const sign = muLaw & 0x80
  const exponent = (muLaw >> 4) & 0x07
  const mantissa = muLaw & 0x0F
  let sample = ((mantissa << 3) + 0x84) << exponent
  sample -= 0x84
  return (sign ? -sample : sample) / 32_768
}
