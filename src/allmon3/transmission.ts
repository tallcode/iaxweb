import type { NodeStatus, StatusSnapshot, TransmitSource } from './types.js'

interface TransmissionState {
  activeSource: TransmitSource
  lastTransmitAt: string | null
}

export class TransmissionTracker {
  private readonly states = new Map<string, TransmissionState>()
  private readonly now: () => string

  constructor(now: () => string = () => new Date().toISOString()) {
    this.now = now
  }

  enrich(snapshot: StatusSnapshot): void {
    for (const [node, status] of Object.entries(snapshot)) {
      if (status.TYPE === 'HUB') {
        this.states.delete(node)
        status.TX_SOURCE = null
        status.LAST_TX_AT = null
        continue
      }

      const source = transmitSource(status)
      const previous = this.states.get(node)
      const startedTransmitting = source !== null && previous?.activeSource == null
      const lastTransmitAt = startedTransmitting
        ? this.now()
        : previous?.lastTransmitAt ?? null

      this.states.set(node, { activeSource: source, lastTransmitAt })
      status.TX_SOURCE = source
      status.LAST_TX_AT = lastTransmitAt
    }
  }

  delete(node: string): void {
    this.states.delete(node)
  }
}

export function transmitSource(status: NodeStatus): TransmitSource {
  if (status.ERROR || status.TXKEYED !== true)
    return null
  if (status.RXKEYED === true)
    return 'local'
  if (status.CONNKEYED === true)
    return 'remote'
  return 'system'
}
