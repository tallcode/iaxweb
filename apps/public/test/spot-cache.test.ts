// @vitest-environment jsdom
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useStatusStore } from '../src/stores/status-store'

afterEach(() => vi.unstubAllGlobals())

describe('spot cache retention', () => {
  it('evicts the oldest event by timestamp even when events arrive out of order', () => {
    const sockets: EventTarget[] = []
    vi.stubGlobal('WebSocket', class extends EventTarget {
      constructor() {
        super()
        sockets.push(this)
      }

      close(): void {}
    })
    setActivePinia(createPinia())
    const store = useStatusStore()
    store.startStatusStream()
    const send = (index: number, callsign: string): void => {
      sockets[0]!.dispatchEvent(new MessageEvent('message', {
        data: JSON.stringify({ at: new Date(1_700_000_000_000 + index * 1_000).toISOString(), callsign, id: String(index), node: '1900', type: 'spot' }),
      }))
    }
    try {
      // All events have one callsign, so a display-only limit would not evict any.
      for (let index = 1_000; index >= 0; index--)
        send(index, 'BG5AAA')
      expect(store.recentSpots).toHaveLength(1)
      expect(store.recentSpots[0]!.id).toBe('1000')

      for (let index = 1; index <= 1_000; index++)
        send(index, 'N0CALL')
      expect(store.recentSpots).toEqual([])
    }
    finally {
      store.stopStatusStream()
    }
  })
})
