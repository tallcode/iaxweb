// @vitest-environment jsdom
import type { SpotEvent, StatusStreamMessage } from '@iaxweb/contracts'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, expect, it, vi } from 'vitest'
import { useStatusStore } from '../src/stores/status-store'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('replaces spot history on reconnect and applies subsequent live corrections and removals', async () => {
  vi.useFakeTimers()
  const sockets: EventTarget[] = []
  vi.stubGlobal('WebSocket', class extends EventTarget {
    constructor() {
      super()
      sockets.push(this)
    }

    close(): void {}
  })
  const first = { id: 'first', node: '1900', callsign: 'BG5AAA', at: '2026-11-17T00:00:00.000Z' }
  const next = { ...first, id: 'second', callsign: 'BG5BBB' }
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  setActivePinia(createPinia())
  const store = useStatusStore()
  const snapshot: StatusStreamMessage = {
    type: 'snapshot',
    nodes: { 1900: { AI: true, NAME: 'Hub', ONLINE: false, LISTENERS: 2 } },
  }
  const runtime: StatusStreamMessage = { type: 'state', nodes: { 1900: { ONLINE: true } } }
  const send = (message: SpotEvent | StatusStreamMessage) => sockets.at(-1)!.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }))
  const sendSpot = (spot: SpotEvent) => send({ ...spot, type: 'spot' })
  try {
    store.startStatusStream()
    sockets[0]!.dispatchEvent(new Event('open'))
    send({ type: 'history', spots: [first] })
    expect(store.spotHistoryReady).toBe(true)
    expect(store.recentSpots).toEqual([first])
    expect(store.connectionState).toBe('waiting-snapshot')
    send(snapshot)
    send(runtime)
    expect(store.statusSnapshot).toEqual({ 1900: { AI: true, NAME: 'Hub', ONLINE: true } })
    expect(store.spotHistoryReady).toBe(true)
    expect(store.recentSpots).toEqual([first])
    sockets[0]!.dispatchEvent(new Event('close'))
    await vi.advanceTimersByTimeAsync(1000)
    sockets[1]!.dispatchEvent(new Event('open'))
    send(runtime)
    expect(store.connectionState).toBe('invalid-data')
    send({ type: 'history', spots: [next] })
    expect(store.recentSpots).toEqual([next])
    send(snapshot)
    sendSpot({ ...next, callsign: 'BG5ABC' })
    send({ type: 'snapshot', nodes: { 1900: { AI: true, NAME: 'Updated Hub', ONLINE: false } } })
    expect(store.recentSpots.map(spot => spot.callsign)).toEqual(['BG5ABC'])
    sendSpot({ ...next, callsign: 'N0CALL' })
    expect(store.recentSpots).toEqual([])

    sendSpot(next)
    expect(store.recentSpots).toHaveLength(1)
    send({ type: 'snapshot', nodes: { 1900: { AI: true, AI_SPOT: false } } })
    sendSpot(first)
    expect(store.aiSpotEnabled).toBe(false)
    expect(store.recentSpots).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  }
  finally {
    store.stopStatusStream()
  }
})
