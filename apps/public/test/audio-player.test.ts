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

describe('audio playback cancellation', () => {
  let player: AudioStreamPlayer
  let contexts: FakeContext[]
  let sockets: FakeSocket[]

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
})
