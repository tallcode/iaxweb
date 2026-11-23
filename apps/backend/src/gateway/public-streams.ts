import type { AudioState } from '@iaxweb/contracts'
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

export class PublicStreams {
  private readonly audioClients = new Map<string, Set<WebSocket>>()
  private readonly statusClients = new Set<WebSocket>()
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
    this.statusClients.add(client)
    client.once('close', () => this.statusClients.delete(client))
    if (snapshot)
      client.send(this.serializeSnapshot(snapshot))
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
    this.sendStatus(this.serializeSnapshot(snapshot))
  }

  publishSpot(spot: SpotEvent): void {
    this.sendStatus(JSON.stringify({ type: 'spot', ...spot }))
  }

  private serializeSnapshot(snapshot: StatusSnapshot): string {
    return JSON.stringify(publicStatusSnapshot(snapshot, this.audioListeners, this.options.spotPublishingEnabled))
  }

  private sendStatus(message: string): void {
    for (const client of this.statusClients) {
      if (client.readyState === client.OPEN)
        client.send(message)
    }
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
