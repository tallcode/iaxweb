import type { InjectionKey } from 'vue'
import { shallowRef } from 'vue'
import { ReconnectingWebSocket } from './reconnecting-websocket'

const SAMPLE_RATE = 8_000
const JITTER_SECONDS = 0.1
const MAX_SCHEDULE_AHEAD_SECONDS = 0.5
const MAX_PLAYBACK_LAG_SECONDS = 0.05
const CLOCK_RESET_MS = 1_000

export const audioPlayerKey: InjectionKey<AudioStreamPlayer> = Symbol('audioPlayer')

export class AudioStreamPlayer {
  private analyser: AnalyserNode | null = null
  private connection: ReconnectingWebSocket | null = null
  private lastFrame: { timestamp: number, startTime: number } | null = null
  private readonly playback = shallowRef<{ nodeId: string, context: AudioContext } | null>(null)
  private playbackVersion = 0
  private readonly scheduledSources = new Set<AudioBufferSourceNode>()

  get playingNodeId(): string | null {
    return this.playback.value?.nodeId ?? null
  }

  async toggle(nodeId: string): Promise<void> {
    if (this.playingNodeId === nodeId) {
      await this.stop()
      return
    }
    await this.start(nodeId)
  }

  async start(nodeId: string): Promise<void> {
    const context = new AudioContext({ sampleRate: SAMPLE_RATE })
    const version = ++this.playbackVersion
    const closing = this.releasePlayback()
    this.playback.value = { nodeId, context }
    try {
      await Promise.all([closing, context.resume()])
      if (version !== this.playbackVersion)
        return
      this.resetTimeline()
      this.connection = new ReconnectingWebSocket(`/audio/${encodeURIComponent(nodeId)}`, {
        binaryType: 'arraybuffer',
        delays: [1_000, 2_000, 8_000, 32_000],
        maxFailures: 4,
        onDisconnect: () => {
          if (version === this.playbackVersion)
            this.resetTimeline()
        },
        onExhausted: () => {
          if (version === this.playbackVersion)
            void this.stop(false)
        },
        onMessage: (event) => {
          if (version === this.playbackVersion)
            this.handleMessage(event)
        },
      })
      this.connection.start()
    }
    catch (error) {
      if (version !== this.playbackVersion)
        return
      await this.stop()
      throw error
    }
  }

  async stop(closeSocket = true): Promise<void> {
    ++this.playbackVersion
    await this.releasePlayback(closeSocket)
  }

  private async releasePlayback(closeSocket = true): Promise<void> {
    const connection = this.connection
    this.connection = null
    if (closeSocket)
      connection?.stop(1000, 'Playback stopped')

    const context = this.playback.value?.context
    this.playback.value = null
    this.analyser = null
    this.resetTimeline()
    if (context && context.state !== 'closed')
      await context.close()
  }

  attachAnalyser(): { analyser: AnalyserNode, detach: () => void } | undefined {
    const context = this.playback.value?.context
    if (!context)
      return

    const analyser = context.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.7
    this.analyser = analyser
    return {
      analyser,
      detach: () => {
        if (this.analyser === analyser)
          this.analyser = null
      },
    }
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
    const context = this.playback.value?.context
    if (!context || data.byteLength < 11)
      return false
    const view = new DataView(data)
    if (view.getUint8(0) !== 1 || view.getUint8(1) !== 1)
      return false

    const timestamp = view.getUint32(6, false)
    const now = context.currentTime
    const previous = this.lastFrame
    let startTime = now + JITTER_SECONDS
    if (previous) {
      // The rolling reference preserves small signed deltas across uint32 wrap.
      const elapsedMs = (timestamp - previous.timestamp) | 0
      if (elapsedMs <= 0 && elapsedMs >= -CLOCK_RESET_MS)
        return true // Valid transport data, but the frame is late or duplicated.
      const projected = previous.startTime + elapsedMs / 1_000
      if (elapsedMs < 0 || projected < now - MAX_PLAYBACK_LAG_SECONDS || projected > now + MAX_SCHEDULE_AHEAD_SECONDS)
        this.resetTimeline()
      else
        startTime = projected
    }

    const encoded = new Uint8Array(data, 10)
    const buffer = context.createBuffer(1, encoded.length, SAMPLE_RATE)
    const samples = buffer.getChannelData(0)
    encoded.forEach((value, index) => samples[index] = decodeMuLaw(value))
    const source = context.createBufferSource()
    source.buffer = buffer
    // Keep scheduled sound connected when the topology meter unmounts.
    source.connect(context.destination)
    if (this.analyser)
      source.connect(this.analyser)
    source.onended = () => this.scheduledSources.delete(source)
    source.start(Math.max(startTime, now))
    this.scheduledSources.add(source)
    this.lastFrame = { timestamp, startTime }
    return true
  }

  private resetTimeline(): void {
    this.lastFrame = null
    for (const source of this.scheduledSources)
      source.stop()
    this.scheduledSources.clear()
  }
}

function decodeMuLaw(value: number): number {
  const muLaw = (~value) & 0xFF
  const sign = muLaw & 0x80
  const exponent = (muLaw >> 4) & 0x07
  const mantissa = muLaw & 0x0F
  const sample = (((mantissa << 3) + 0x84) << exponent) - 0x84
  return (sign ? -sample : sample) / 32_768
}
