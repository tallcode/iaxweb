import type { PublicStatusSnapshot } from '@iaxweb/contracts'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { isFaviconTransmission } from '../src/composables/use-transmission-favicon'
import { countyState, mapStates } from '../src/services/map-county-status'
import { MAP_MAX_ZOOM, mapViewBox, panMapViewport, zoomMapViewport, zoomMapViewportTowardCenter } from '../src/services/map-viewport'
import { ReconnectingWebSocket } from '../src/services/reconnecting-websocket'
import { formatRepeaterSummary } from '../src/services/status-presentation'
import { markSnapshotOffline } from '../src/services/status-stream'
import { buildTopologyEdges, createTopologySignature } from '../src/services/topology-graph'
import { useStatusStore } from '../src/stores/status-store'

class FakeSocket extends EventTarget {
  binaryType: BinaryType = 'blob'

  close(): void {
    this.dispatchEvent(new Event('close'))
  }
}

describe('reconnecting WebSocket', () => {
  it('resets retry failures only after valid data is marked healthy', () => {
    const sockets: FakeSocket[] = []
    const timers: Array<{ callback: () => void, delay: number }> = []
    const failures: number[] = []
    const connection = new ReconnectingWebSocket('/status', {
      createSocket: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
      delays: [10, 20],
      onDisconnect: failureCount => failures.push(failureCount),
      setTimer: (callback, delay) => {
        timers.push({ callback, delay })
        return timers.length as unknown as ReturnType<typeof setTimeout>
      },
      url: () => 'ws://example/status',
    })

    connection.start()
    sockets[0]?.close()
    expect(failures).toEqual([1])
    expect(timers[0]?.delay).toBe(10)
    timers[0]?.callback()
    sockets[1]?.close()
    expect(failures).toEqual([1, 2])
    timers[1]?.callback()
    connection.markHealthy()
    sockets[2]?.close()
    expect(failures).toEqual([1, 2, 1])
  })
})

describe('status models', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('counts only repeaters in the status summary', () => {
    const store = useStatusStore()
    store.statusSnapshot = {
      1800: { ONLINE: true, TX_SOURCE: 'local', TYPE: 'REPEATER' },
      1801: { ONLINE: false, TX_SOURCE: null, TYPE: 'REPEATER' },
      1900: { ONLINE: true, TX_SOURCE: null, TYPE: 'HUB' },
    }

    expect(store.repeaterSummary).toEqual({ online: 1, total: 2, transmitting: 1 })
    expect(formatRepeaterSummary(store.repeaterSummary, false)).toBe('2 个节点 · 1 个在线 · 1 个正在发射')
    expect(formatRepeaterSummary(store.repeaterSummary, true)).toBe('2/1/1')
  })

  it('keeps static metadata and clears live fields after expiry', () => {
    const expired = markSnapshotOffline({
      1900: {
        AUDIO: true,
        CONNS: { 1901: { CSTATE: 'ESTABLISHED' } },
        DESC: 'Hub',
        LINK: ['1901'],
        LISTENERS: 3,
        ONLINE: true,
        TX_SOURCE: 'system',
        TYPE: 'HUB',
      },
    })
    expect(expired['1900']).toMatchObject({
      AUDIO: true,
      CONNS: {},
      DESC: 'Hub',
      LINK: ['1901'],
      LISTENERS: 0,
      ONLINE: false,
      TX_SOURCE: null,
    })
  })

  it('draws planned and established links without relayout for state-only changes', () => {
    const disconnected: PublicStatusSnapshot = {
      1900: { CONNS: {}, LINK: ['1901'] },
      1901: { CONNS: {}, LINK: [] },
      1902: { CONNS: {}, LINK: [] },
    }
    const connected: PublicStatusSnapshot = {
      ...disconnected,
      1900: { CONNS: { 1901: { CSTATE: 'ESTABLISHED' } }, LINK: ['1901'] },
      1902: { CONNS: { 1901: { CSTATE: 'ESTABLISHED' } }, LINK: [] },
    }
    const fixedConnected: PublicStatusSnapshot = {
      ...disconnected,
      1900: { CONNS: { 1901: { CSTATE: 'ESTABLISHED' } }, LINK: ['1901'] },
    }
    const plannedEdges = buildTopologyEdges(disconnected)
    const connectedEdges = buildTopologyEdges(connected)
    const fixedConnectedEdges = buildTopologyEdges(fixedConnected)

    expect(plannedEdges).toEqual([{ connected: false, source: '1900', target: '1901' }])
    expect(connectedEdges).toEqual([
      { connected: true, source: '1900', target: '1901' },
      { connected: true, source: '1901', target: '1902' },
    ])
    expect(createTopologySignature(Object.keys(disconnected), plannedEdges, false))
      .not
      .toBe(createTopologySignature(Object.keys(connected), connectedEdges, false))
    expect(createTopologySignature(['1900', '1901'], plannedEdges, false))
      .toBe(createTopologySignature(['1901', '1900'], plannedEdges, false))
    expect(createTopologySignature(Object.keys(disconnected), plannedEdges, false))
      .toBe(createTopologySignature(Object.keys(fixedConnected), fixedConnectedEdges, false))
  })
})

describe('map viewport', () => {
  it('zooms around the pointer and clamps between the map bounds and 10x', () => {
    const centered = zoomMapViewport({ x: 0, y: 0, zoom: 1 }, 672, 420, 2, 1344, 840)
    expect(centered).toEqual({ x: 336, y: 210, zoom: 2 })
    expect(mapViewBox(centered, 1344, 840)).toBe('336 210 672 420')

    const maximum = zoomMapViewport(centered, 672, 420, 100, 1344, 840)
    expect(maximum.zoom).toBe(MAP_MAX_ZOOM)
    expect(maximum.x).toBeGreaterThanOrEqual(0)
    expect(maximum.y).toBeGreaterThanOrEqual(0)
    expect(maximum.x + 1344 / maximum.zoom).toBeLessThanOrEqual(1344)
    expect(maximum.y + 840 / maximum.zoom).toBeLessThanOrEqual(840)

    expect(zoomMapViewport(maximum, 672, 420, 0.001, 1344, 840)).toEqual({ x: 0, y: 0, zoom: 1 })
  })

  it('pans a zoomed viewport without leaving the map bounds', () => {
    const viewport = { x: 336, y: 210, zoom: 2 }
    expect(panMapViewport(viewport, 100, -300, 1344, 840)).toEqual({ x: 436, y: 0, zoom: 2 })
    expect(panMapViewport(viewport, 10_000, 10_000, 1344, 840)).toEqual({ x: 672, y: 420, zoom: 2 })
  })

  it('moves a panned viewport progressively toward the map center while zooming out', () => {
    const viewport = { x: 100, y: 50, zoom: 10 }
    const currentCenter = { x: 167.2, y: 92 }
    const halfway = zoomMapViewportTowardCenter(viewport, 0.5, 1344, 840)
    const halfwayCenter = { x: halfway.x + 1344 / halfway.zoom / 2, y: halfway.y + 840 / halfway.zoom / 2 }

    expect(halfway.zoom).toBe(5)
    expect(halfwayCenter.x - 672).toBeCloseTo((currentCenter.x - 672) * 0.5)
    expect(halfwayCenter.y - 420).toBeCloseTo((currentCenter.y - 420) * 0.5)
    expect(zoomMapViewportTowardCenter(halfway, 0.001, 1344, 840)).toEqual({ x: 0, y: 0, zoom: 1 })
  })

  it('smoothly removes the remaining center offset near 1x', () => {
    const viewport = { x: 20, y: 10, zoom: 1.4 }
    const currentCenter = { x: viewport.x + 1344 / viewport.zoom / 2, y: viewport.y + 840 / viewport.zoom / 2 }
    const nearMinimum = zoomMapViewportTowardCenter(viewport, 1.1 / 1.4, 1344, 840)
    const nextCenter = { x: nearMinimum.x + 1344 / nearMinimum.zoom / 2, y: nearMinimum.y + 840 / nearMinimum.zoom / 2 }

    expect(nextCenter.x - 672).toBeCloseTo((currentCenter.x - 672) * 0.25)
    expect(nextCenter.y - 420).toBeCloseTo((currentCenter.y - 420) * 0.25)
  })

  it('rejects invalid interaction coordinates before they reach the SVG viewBox', () => {
    const viewport = { x: 100, y: 50, zoom: 2 }
    expect(zoomMapViewport(viewport, Number.NaN, 420, 2, 1344, 840)).toBe(viewport)
    expect(panMapViewport(viewport, Number.NaN, 0, 1344, 840)).toBe(viewport)
    expect(mapViewBox({ x: Number.NaN, y: 0, zoom: 1 }, 1344, 840)).toBe('0 0 1 1')
  })
})

describe('transmission favicon', () => {
  it('activates only for local and remote repeater transmission', () => {
    expect(isFaviconTransmission({ TYPE: 'REPEATER', TX_SOURCE: 'local' })).toBe(true)
    expect(isFaviconTransmission({ TYPE: 'REPEATER', TX_SOURCE: 'remote' })).toBe(true)
    expect(isFaviconTransmission({ TYPE: 'REPEATER', TX_SOURCE: 'system' })).toBe(false)
    expect(isFaviconTransmission({ TYPE: 'HUB', TX_SOURCE: 'local' })).toBe(false)
    expect(isFaviconTransmission({ TYPE: 'REPEATER', TX_SOURCE: null })).toBe(false)
  })
})

describe('map county states', () => {
  it('uses city online state while keeping transmission state on its county', () => {
    const states = mapStates({
      1801: { GB: '156330481', ONLINE: true, TX_SOURCE: 'remote', TYPE: 'REPEATER' },
      1802: { GB: '156330424', ONLINE: true, TX_SOURCE: 'local', TYPE: 'REPEATER' },
      1803: { GB: '156330482', ONLINE: true, TX_SOURCE: 'system', TYPE: 'REPEATER' },
      1901: { GB: '156330106', ONLINE: true, TX_SOURCE: null, TYPE: 'REPEATER' },
      1902: { GB: '156330203', ONLINE: false, TX_SOURCE: 'system', TYPE: 'REPEATER' },
      1903: { GB: '156330481', ONLINE: true, TX_SOURCE: 'local', TYPE: 'HUB' },
    })

    expect(countyState('156330481', states)).toBe('tx-remote')
    expect(countyState('156330424', states)).toBe('tx-local')
    expect(countyState('156330482', states)).toBe('tx-system')
    expect(countyState('156330499', states)).toBe('online')
    expect(countyState('156330106', states)).toBe('online')
    expect(countyState('156330203', states)).toBe('offline')
  })
})
