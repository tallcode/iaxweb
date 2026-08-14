import type { PublicStatusSnapshot } from '@iaxweb/contracts'
import { describe, expect, it } from 'vitest'
import { ReconnectingWebSocket } from '../src/services/reconnecting-websocket'
import { markSnapshotOffline } from '../src/services/status-stream'
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
