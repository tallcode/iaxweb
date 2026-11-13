// @vitest-environment jsdom
import type { SpectrumMeter } from '../src/services/audio-player'
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

describe('audio playback cancellation', () => {
  let player: AudioStreamPlayer
  let contexts: FakeContext[]
  let sockets: FakeSocket[]
  const labels = { play: 'play', stop: 'stop' }

  class FakeContext {
    state = 'suspended'
    resumeOperation = deferred()
    closeOperation: ReturnType<typeof deferred> | undefined

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
  }

  class FakeSocket extends EventTarget {
    constructor(readonly url: string) {
      super()
      sockets.push(this)
    }

    close(): void {}
  }

  function meter(): SpectrumMeter {
    return { detach: vi.fn(), enabled: false, setPlaying: vi.fn() } as unknown as SpectrumMeter
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
    const button = document.createElement('button')
    const starting = player.start('1900', button, meter(), labels)
    await player.stop()
    contexts[0]!.resumeOperation.resolve()
    await starting

    expect(player.playingNodeId).toBeNull()
    expect(sockets).toHaveLength(0)
    expect(contexts[0]!.state).toBe('closed')
    expect(button.textContent).toBe('play')
  })

  it('ignores a failed old resume after another node starts playing', async () => {
    const first = player.start('1900', document.createElement('button'), meter(), labels)
    const second = player.start('1901', document.createElement('button'), meter(), labels)
    contexts[1]!.resumeOperation.resolve()
    await second
    contexts[0]!.resumeOperation.reject(new Error('Old context was closed'))
    await first

    expect(player.playingNodeId).toBe('1901')
    expect(sockets).toHaveLength(1)
    expect(sockets[0]!.url).toContain('/audio/1901')
    expect(contexts[1]!.state).not.toBe('closed')
  })

  it('does not reset a reused button when an older close finishes', async () => {
    const button = document.createElement('button')
    const first = player.start('1900', button, meter(), labels)
    contexts[0]!.resumeOperation.resolve()
    await first
    const closing = deferred()
    contexts[0]!.closeOperation = closing
    const stopping = player.stop()
    const second = player.start('1900', button, meter(), labels)
    contexts[1]!.resumeOperation.resolve()
    await second
    closing.resolve()
    await stopping

    expect(player.playingNodeId).toBe('1900')
    expect(button.textContent).toBe('stop')
    expect(button.getAttribute('aria-pressed')).toBe('true')
  })
})
