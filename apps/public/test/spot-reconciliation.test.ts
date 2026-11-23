// @vitest-environment jsdom
import type { SpotEvent } from '@iaxweb/contracts'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, expect, it, vi } from 'vitest'
import { useStatusStore } from '../src/stores/status-store'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('reconciles on reconnect and replays corrections received during a stale history response', async () => {
  vi.useFakeTimers()
  const sockets: EventTarget[] = []
  vi.stubGlobal('WebSocket', class extends EventTarget {
    constructor() {
      super()
      sockets.push(this)
    }

    close(): void {}
  })
  let resolveHistory!: (response: Response) => void
  const first = { id: 'first', node: '1900', callsign: 'BG5AAA', at: '2026-11-17T00:00:00.000Z' }
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json([first])).mockImplementationOnce(() => new Promise<Response>((resolve) => {
    resolveHistory = resolve
  }))
  vi.stubGlobal('fetch', fetchMock)
  setActivePinia(createPinia())
  const store = useStatusStore()
  const snapshot = () => new MessageEvent('message', { data: JSON.stringify({ 1900: { AI: true } }) })
  const send = (spot: SpotEvent) => sockets.at(-1)!.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ ...spot, type: 'spot' }) }))
  try {
    store.startStatusStream()
    sockets[0]!.dispatchEvent(new Event('open'))
    sockets[0]!.dispatchEvent(snapshot())
    await vi.waitFor(() => expect(store.recentSpots).toHaveLength(1))
    sockets[0]!.dispatchEvent(new Event('close'))
    await vi.advanceTimersByTimeAsync(1000)
    sockets[1]!.dispatchEvent(new Event('open'))
    sockets[1]!.dispatchEvent(snapshot())
    expect(fetchMock).toHaveBeenCalledTimes(2)
    send({ ...first, callsign: 'N0CALL' })
    send({ ...first, id: 'second', callsign: 'BG5BBB' })
    resolveHistory(Response.json([first]))
    await vi.waitFor(() => expect(store.recentSpots.map(spot => spot.callsign)).toEqual(['BG5BBB']))

    sockets[1]!.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ 1900: { AI: true, AI_SPOT: false } }) }))
    send(first)
    expect(store.aiSpotEnabled).toBe(false)
    expect(store.recentSpots).toHaveLength(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  }
  finally {
    store.stopStatusStream()
  }
})
