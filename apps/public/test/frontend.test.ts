import type { PublicStatusSnapshot } from '@iaxweb/contracts'
import { describe, expect, it, vi } from 'vitest'
import { isFaviconTransmission } from '../src/composables/use-transmission-favicon'
import { mapRepeaterMarkers } from '../src/services/map-county-status'
import { MAP_MAX_ZOOM, mapViewBox, panMapViewport, zoomMapViewport, zoomMapViewportTowardCenter } from '../src/services/map-viewport'
import { ReconnectingWebSocket } from '../src/services/reconnecting-websocket'
import { repeaterSummaryDots } from '../src/services/status-presentation'
import { markSnapshotOffline } from '../src/services/status-stream'
import { buildTopologyEdges, createTopologySignature } from '../src/services/topology-graph'

class FakeSocket extends EventTarget {
  binaryType: BinaryType = 'blob'
  readonly sent: string[] = []

  send(data: string): void {
    this.sent.push(data)
  }

  close(code = 1000, reason = ''): void {
    this.dispatchEvent(Object.assign(new Event('close'), { code, reason }))
  }
}

describe('reconnecting WebSocket', () => {
  it('verifies the initial challenge without forwarding it to the message handler', () => {
    const socket = new FakeSocket()
    const onMessage = vi.fn()
    const connection = new ReconnectingWebSocket('/status', {
      createSocket: () => socket,
      onMessage,
      url: () => 'ws://example/status',
    })
    const nonce = '0123456789abcdef0123456789abcdef'
    const challenge = new MessageEvent('message', { data: JSON.stringify({ type: 'challenge', nonce }) })
    const snapshot = new MessageEvent('message', { data: JSON.stringify({ type: 'snapshot', nodes: {} }) })
    const audio = new MessageEvent('message', { data: new ArrayBuffer(12) })

    connection.start()
    socket.dispatchEvent(new Event('open'))
    socket.dispatchEvent(challenge)
    expect(socket.sent.map(message => JSON.parse(message))).toEqual([{ type: 'verify', proof: '86d04db5' }])
    expect(onMessage).not.toHaveBeenCalled()

    socket.dispatchEvent(snapshot)
    socket.dispatchEvent(audio)
    expect(onMessage.mock.calls).toEqual([[snapshot], [audio]])
    connection.stop()
  })

  it('does not retry after the server rejects verification', () => {
    const socket = new FakeSocket()
    const setTimer = vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>)
    const connection = new ReconnectingWebSocket('/status', {
      createSocket: () => socket,
      setTimer,
      url: () => 'ws://example/status',
    })

    connection.start()
    socket.close(1008, 'Verification failed')
    expect(setTimer).not.toHaveBeenCalled()
    connection.stop()
  })

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
  it('shows the configured repeaters in summary order with their current status', () => {
    const dots = repeaterSummaryDots({
      1801: { NAME: 'BR5AF', ONLINE: true, TX_SOURCE: 'remote', TYPE: 'REPEATER' },
      1802: { NAME: 'BR5AO', ONLINE: true, TX_SOURCE: 'system', TYPE: 'REPEATER' },
      1803: { NAME: 'BR5AR', ONLINE: false, TX_SOURCE: 'local', TYPE: 'REPEATER' },
      1901: { NAME: 'BR5AI', ONLINE: true, TYPE: 'REPEATER' },
      1902: { NAME: 'BR5BB', ONLINE: true, TX_SOURCE: 'local', TYPE: 'REPEATER' },
    })

    expect(dots.map(({ callsign, state }) => [callsign, state])).toEqual([
      ['BR5AI', 'online'],
      ['BR5BB', 'local'],
      ['BR5AF', 'remote'],
      ['BR5AO', 'system'],
      ['BR5AR', 'offline'],
    ])
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

describe('map county markers', () => {
  it('uses the callsign and state of the highest-priority repeater in each county', () => {
    const markers = mapRepeaterMarkers({
      1801: { GB: '156330481', ONLINE: true, TX_SOURCE: 'remote', TYPE: 'REPEATER' },
      1802: { GB: '156330424', NAME: 'BR5AO', ONLINE: true, TX_SOURCE: 'local', TYPE: 'REPEATER' },
      1803: { GB: '156330482', NAME: 'BR5AR', ONLINE: false, TYPE: 'REPEATER' },
      1901: { GB: '156330106', ONLINE: true, TX_SOURCE: null, TYPE: 'REPEATER' },
      1902: { GB: '156330203', ONLINE: false, TX_SOURCE: 'system', TYPE: 'REPEATER' },
      1903: { GB: '156330481', ONLINE: true, TX_SOURCE: 'local', TYPE: 'HUB' },
      1904: { GB: '156330424', NAME: 'BR5ZZ', ONLINE: true, TX_SOURCE: 'system', TYPE: 'REPEATER' },
    }, [
      { gb: '156330481', name: '海宁市', center: [0, 0], path: '' },
      { gb: '156330424', name: '海盐县', center: [1, 0], path: '' },
      { gb: '156330482', name: '平湖市', center: [2, 0], path: '' },
      { gb: '156330499', name: '无中继区县', center: [3, 0], path: '' },
      { gb: '156330106', name: '西湖区', center: [4, 0], path: '' },
      { gb: '156330203', name: '海曙区', center: [5, 0], path: '' },
    ])

    expect(markers.map(({ name, state }) => [name, state])).toEqual([
      ['海宁市', 'remote'],
      ['BR5AO', 'local'],
      ['BR5AR', 'offline'],
      ['西湖区', 'online'],
      ['海曙区', 'offline'],
    ])
  })
})
