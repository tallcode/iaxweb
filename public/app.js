const SAMPLE_RATE = 8_000
const JITTER_SECONDS = 0.1
const SPECTRUM_BARS = 28
const RECONNECT_DELAYS = [1_000, 2_000, 8_000, 32_000]

class Player {
  constructor(button, meter) {
    this.button = button
    this.meter = meter
    this.socket = null
    this.context = null
    this.analyser = null
    this.reconnectAttempts = 0
    this.reconnectTimer = null
    this.baseTimestamp = null
    this.baseAudioTime = 0
    this.lastTimestamp = null
  }

  async start() {
    if (this.context)
      return

    const context = new AudioContext({ sampleRate: SAMPLE_RATE })
    await context.resume()
    this.context = context

    const analyser = context.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.7
    analyser.connect(context.destination)
    this.analyser = analyser
    this.meter.attach(analyser)

    this.resetTimeline()
    this.reconnectAttempts = 0
    this.setPlaying(true)
    this.connect()
  }

  connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${protocol}//${location.host}/audio`)
    socket.binaryType = 'arraybuffer'
    this.socket = socket
    this.resetTimeline()

    socket.addEventListener('open', () => {
      // A live connection restores the full retry budget for the next drop.
      this.reconnectAttempts = 0
    })
    socket.addEventListener('message', event => this.handleMessage(event))
    socket.addEventListener('close', () => {
      if (this.socket === socket)
        this.scheduleReconnect()
    })
    socket.addEventListener('error', () => socket.close())
  }

  scheduleReconnect() {
    this.socket = null
    this.resetTimeline()

    const delay = RECONNECT_DELAYS[this.reconnectAttempts]
    if (delay === undefined) {
      // Retries exhausted; tear the session down.
      void this.stop()
      return
    }

    this.reconnectAttempts++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.context)
        this.connect()
    }, delay)
  }

  async stop(closeSocket = true) {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    const socket = this.socket
    this.socket = null
    if (closeSocket)
      socket?.close(1000, 'Playback stopped')

    this.meter.detach()
    this.analyser = null

    const context = this.context
    this.context = null
    this.resetTimeline()
    await context?.close()
    this.setPlaying(false)
  }

  handleMessage(event) {
    if (typeof event.data === 'string') {
      try {
        const message = JSON.parse(event.data)
        if (message.type === 'state' && message.online === false)
          this.resetTimeline()
      }
      catch {
        // Ignore unknown control messages; audio can continue independently.
      }
      return
    }

    this.scheduleFrame(event.data)
  }

  scheduleFrame(data) {
    const context = this.context
    if (!context || data.byteLength < 11)
      return

    const view = new DataView(data)
    if (view.getUint8(0) !== 1 || view.getUint8(1) !== 1)
      return

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
  }

  resetTimeline() {
    this.baseTimestamp = null
    this.baseAudioTime = 0
    this.lastTimestamp = null
  }

  setPlaying(playing) {
    this.button.textContent = playing ? '停止' : '播放'
    this.button.setAttribute('aria-pressed', String(playing))
  }
}

class Meter {
  constructor(root) {
    this.spectrum = root.querySelector('#spectrum')
    this.levelFill = root.querySelector('#level-fill')
    this.levelPeak = root.querySelector('#level-peak')

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
    this.levelFill.style.transform = 'scaleX(0)'
    this.levelPeak.style.left = '0%'
  }

  render() {
    const analyser = this.analyser
    if (!analyser)
      return

    this.frame = requestAnimationFrame(this.render)

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

const button = document.querySelector('#play')
const meter = new Meter(document)
const player = new Player(button, meter)

button.addEventListener('click', () => {
  if (player.context)
    void player.stop()
  else
    void player.start().catch(() => player.stop())
})
