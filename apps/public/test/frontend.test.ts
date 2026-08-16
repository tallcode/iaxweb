import type { PublicStatusSnapshot } from '@iaxweb/contracts'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { isFaviconTransmission } from '../src/composables/use-transmission-favicon'
import { countyState, mapStates } from '../src/services/map-county-status'
import { ReconnectingWebSocket } from '../src/services/reconnecting-websocket'
import { markSnapshotOffline } from '../src/services/status-stream'
import { useStatusStore } from '../src/stores/status-store'
import { buildTopologyEdges, createTopologySignature } from '../src/services/topology-graph'

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

    store.updateSummary()
    expect(store.statusMessage).toBe('2 个节点 · 1 个在线 · 1 个正在发射')
    store.updateSummary(true)
    expect(store.statusMessage).toBe('2/1/1')
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
