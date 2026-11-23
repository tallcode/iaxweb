// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AudioStreamPlayer } from '../src/services/audio-player'

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, reject, resolve }
}

describe('audio playback', () => {
  let player: AudioStreamPlayer
  let contexts: FakeContext[]
  let sockets: FakeSocket[]

  class FakeSource {
    connect = vi.fn()
    start = vi.fn<(time: number) => void>()
    stop = vi.fn()
  }

  class FakeContext {
    state = 'suspended'
    currentTime = 0
    destination = {}
    resumeOperation = deferred()
    closeOperation: ReturnType<typeof deferred> | undefined
    sources: FakeSource[] = []

    constructor() {
      contexts.push(this)
    }

    resume(): Promise<void> {
      return this.resumeOperation.promise
    }

    async close(): Promise<void> {
      this.state = 'closed'
      await this.closeOperation?.promise
    }

    createBuffer(_channels: number, length: number) {
      return { getChannelData: () => new Float32Array(length) }
    }

    createBufferSource(): FakeSource {
      const source = new FakeSource()
      this.sources.push(source)
      return source
    }
  }

  class FakeSocket extends EventTarget {
    constructor(readonly url: string) {
      super()
      sockets.push(this)
    }

    close(): void {}

    frame(timestamp: number): void {
      const data = new ArrayBuffer(170)
      const view = new DataView(data)
      view.setUint8(0, 1)
      view.setUint8(1, 1)
      view.setUint32(6, timestamp, false)
      this.dispatchEvent(new MessageEvent('message', { data }))
    }
  }

  beforeEach(() => {
    contexts = []
    sockets = []
    vi.stubGlobal('AudioContext', FakeContext)
    vi.stubGlobal('WebSocket', FakeSocket)
    player = new AudioStreamPlayer()
  })

  afterEach(async () => {
    await player.stop()
    vi.unstubAllGlobals()
  })

  it('does not open a socket when stopped before resume completes', async () => {
    const starting = player.start('1900')
    await player.stop()
    contexts[0]!.resumeOperation.resolve()
    await starting

    expect(player.playingNodeId).toBeNull()
    expect(sockets).toHaveLength(0)
    expect(contexts[0]!.state).toBe('closed')
  })

  it('ignores a failed old resume after another node starts playing', async () => {
    const first = player.start('1900')
    const second = player.start('1901')
    contexts[1]!.resumeOperation.resolve()
    await second
    contexts[0]!.resumeOperation.reject(new Error('Old context was closed'))
    await first

    expect(player.playingNodeId).toBe('1901')
    expect(sockets).toHaveLength(1)
    expect(sockets[0]!.url).toContain('/audio/1901')
    expect(contexts[1]!.state).not.toBe('closed')
  })

  it('keeps the new playback active when an older close finishes', async () => {
    const first = player.start('1900')
    contexts[0]!.resumeOperation.resolve()
    await first
    const closing = deferred()
    contexts[0]!.closeOperation = closing
    const stopping = player.stop()
    const second = player.start('1900')
    contexts[1]!.resumeOperation.resolve()
    await second
    closing.resolve()
    await stopping

    expect(player.playingNodeId).toBe('1900')
    expect(sockets).toHaveLength(2)
    expect(contexts[1]!.state).not.toBe('closed')
  })

  it('drops an out-of-order frame and schedules across timestamp rollover', async () => {
    const starting = player.start('1900')
    const context = contexts[0]!
    context.resumeOperation.resolve()
    await starting

    const socket = sockets[0]!
    socket.frame(0xFFFF_FFF0)
    socket.frame(0xFFFF_FFDC)
    socket.frame(4)

    expect(context.sources).toHaveLength(2)
    expect(context.sources[1]!.start.mock.calls[0]![0]).toBeCloseTo(0.12)
  })

  it('rebases large forward jumps and cancels previously scheduled audio', async () => {
    const starting = player.start('1900')
    const context = contexts[0]!
    context.resumeOperation.resolve()
    await starting

    const socket = sockets[0]!
    socket.frame(100)
    context.currentTime = 0.02
    socket.frame(10_100)

    expect(context.sources).toHaveLength(2)
    expect(context.sources[0]!.stop).toHaveBeenCalledOnce()
    expect(context.sources[1]!.start.mock.calls[0]![0]).toBeCloseTo(0.12)
  })
})
