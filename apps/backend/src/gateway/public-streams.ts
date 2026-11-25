import type { AudioState, PublicNodeStatus, PublicStatusRuntimeSnapshot, StatusStreamMessage } from '@iaxweb/contracts'
import type { WebSocket } from 'ws'
import type { StatusSnapshot } from '../allmon3/index.js'
import type { SpotEvent } from '../spots/spot-store.js'
import { publicStatusSnapshot } from '../allmon3/index.js'

interface AudioSource {
  readonly currentState: AudioState
  setListenerCount: (count: number) => void
}

interface PublicStreamsOptions {
  audioSources: ReadonlyMap<string, AudioSource>
  hasAiListener: (nodeId: string) => boolean
  spotPublishingEnabled?: boolean
}

interface StatusFrames {
  metadata: string
  snapshot: string
  state: string
}

export class PublicStreams {
  private readonly audioClients = new Map<string, Set<WebSocket>>()
  private readonly statusClients = new Map<WebSocket, StatusFrames | undefined>()
  private readonly audioListeners = new Map<string, number>()

  constructor(private readonly options: PublicStreamsOptions) {}

  hasAudio(nodeId: string): boolean {
    return this.options.audioSources.has(nodeId)
  }

  listenToAudio(nodeId: string, client: WebSocket): void {
    const source = this.options.audioSources.get(nodeId)
    if (!source) {
      client.close(1008, 'Unknown audio node')
      return
    }

    let clients = this.audioClients.get(nodeId)
    if (!clients) {
      clients = new Set()
      this.audioClients.set(nodeId, clients)
    }
    clients.add(client)
    this.updateListenerCount(nodeId, source, clients)
    client.send(JSON.stringify(source.currentState))
    client.once('close', () => {
      clients.delete(client)
      if (clients.size === 0)
        this.audioClients.delete(nodeId)
      this.updateListenerCount(nodeId, source, clients)
    })
  }

  listenToStatus(client: WebSocket, snapshot: StatusSnapshot | undefined): void {
    this.statusClients.set(client, undefined)
    client.once('close', () => this.statusClients.delete(client))
    if (snapshot)
      this.sendStatusSnapshot(client, this.statusFrames(snapshot))
  }

  publishAudio(nodeId: string, data: Uint8Array | string, binary: boolean): void {
    const clients = this.audioClients.get(nodeId)
    if (!clients)
      return
    for (const client of clients) {
      if (client.readyState !== client.OPEN)
        continue

      // Real-time audio is more useful dropped than delivered late.
      if (binary && client.bufferedAmount > 4 * 1024)
        continue

      client.send(data, { binary })
    }
  }

  publishAudioState(nodeId: string, state: AudioState, snapshot: StatusSnapshot | undefined): void {
    this.publishAudio(nodeId, JSON.stringify(state), false)
    const listeners = state.listeners ?? 0
    if ((this.audioListeners.get(nodeId) ?? 0) === listeners)
      return
    this.audioListeners.set(nodeId, listeners)
    if (snapshot)
      this.publishSnapshot(snapshot)
  }

  publishSnapshot(snapshot: StatusSnapshot): void {
    if (this.statusClients.size === 0)
      return

    const frames = this.statusFrames(snapshot)
    for (const [client, previous] of this.statusClients)
      this.sendStatusSnapshot(client, frames, previous)
  }

  publishSpot(spot: SpotEvent): void {
    const message = JSON.stringify({ type: 'spot', ...spot })
    for (const client of this.statusClients.keys()) {
      if (client.readyState === client.OPEN)
        client.send(message)
    }
  }

  private statusFrames(snapshot: StatusSnapshot): StatusFrames {
    const nodes = publicStatusSnapshot(snapshot, this.audioListeners, this.options.spotPublishingEnabled)
    const metadata: Record<string, Omit<PublicNodeStatus, keyof PublicStatusRuntimeSnapshot[string]>> = {}
    const runtime: PublicStatusRuntimeSnapshot = {}
    for (const [nodeId, status] of Object.entries(nodes)) {
      const { CONNS, LAST_TX_AT, LISTENERS, ONLINE, TX_SOURCE, ...properties } = status
      metadata[nodeId] = properties
      runtime[nodeId] = { CONNS, LAST_TX_AT, LISTENERS, ONLINE, TX_SOURCE }
    }

    return {
      metadata: JSON.stringify(metadata),
      snapshot: JSON.stringify({ type: 'snapshot', nodes } satisfies StatusStreamMessage),
      state: JSON.stringify({ type: 'state', nodes: runtime } satisfies StatusStreamMessage),
    }
  }

  private sendStatusSnapshot(client: WebSocket, frames: StatusFrames, previous?: StatusFrames): void {
    if (client.readyState !== client.OPEN)
      return

    // A new connection can see a change before the scheduled broadcast delivers it.
    if (previous?.snapshot === frames.snapshot)
      return

    client.send(previous?.metadata === frames.metadata ? frames.state : frames.snapshot)
    this.statusClients.set(client, frames)
  }

  private updateListenerCount(nodeId: string, source: AudioSource, clients: ReadonlySet<WebSocket>): void {
    // The AI listener keeps the IAX call up even when no browser is playing.
    let count = this.options.hasAiListener(nodeId) ? 1 : 0
    for (const client of clients) {
      if (client.readyState === client.OPEN)
        count++
    }
    source.setListenerCount(count)
  }
}
