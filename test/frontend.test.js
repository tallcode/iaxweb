import assert from 'node:assert/strict'
import test from 'node:test'
import { AudioStreamPlayer, SpectrumMeter } from '../public/audio-player.js'
import { ReconnectingWebSocket } from '../public/reconnecting-websocket.js'
import { expireSnapshot } from '../public/status-client.js'
import { collectEdges, graphSignature } from '../public/topology-model.js'

class FakeSocket extends EventTarget {
  close() {
    this.dispatchEvent(new Event('close'))
  }
}

test('disabled spectrum meters do not create bars or animation frames', () => {
  let appendedBars = 0
  const root = {
    classList: { toggle() {} },
    querySelector: selector => selector === '.spectrum'
      ? { append: () => appendedBars++ }
      : null,
  }
  const meter = new SpectrumMeter(root, { enabled: () => false })

  meter.attach({ fftSize: 256, frequencyBinCount: 128 })

  assert.equal(appendedBars, 0)
  assert.equal(meter.frame, 0)
  assert.equal(meter.analyser, null)
})

test('audio visualization can be disabled without stopping playback', () => {
  let analysersCreated = 0
  let analysersDisconnected = 0
  let attached = 0
  let detached = 0
  const meter = {
    enabled: true,
    attach: () => attached++,
    detach: () => detached++,
  }
  const player = new AudioStreamPlayer()
  player.binding = { meter }
  player.context = {
    createAnalyser: () => {
      analysersCreated++
      return {
        connect() {},
        disconnect: () => analysersDisconnected++,
        fftSize: 0,
        smoothingTimeConstant: 0,
      }
    },
    destination: {},
  }

  player.setVisualizationEnabled(false)
  assert.equal(analysersCreated, 0)
  assert.equal(detached, 1)

  player.setVisualizationEnabled(true)
  assert.equal(analysersCreated, 1)
  assert.equal(attached, 1)
  assert.ok(player.analyser)

  player.setVisualizationEnabled(false)
  assert.equal(detached, 2)
  assert.equal(analysersDisconnected, 1)
  assert.equal(player.analyser, null)
})

test('WebSocket retries reset only after the caller marks valid data healthy', () => {
  const sockets = []
  const timers = []
  const failures = []
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
      return timers.length
    },
    url: () => 'ws://example/status',
  })

  connection.start()
  sockets[0].dispatchEvent(new Event('open'))
  sockets[0].close()
  assert.deepEqual(failures, [1])
  assert.equal(timers[0].delay, 10)

  timers[0].callback()
  sockets[1].close()
  assert.deepEqual(failures, [1, 2])

  timers[1].callback()
  connection.markHealthy()
  sockets[2].close()
  assert.deepEqual(failures, [1, 2, 1])
})

test('expired status keeps static node metadata and clears live fields', () => {
  const expired = expireSnapshot({
    1900: {
      AUDIO: true,
      CONNS: { 1901: { CSTATE: 'ESTABLISHED' } },
      DESC: 'Hub',
      LINK: ['1901'],
      LISTENERS: 3,
      ONLINE: true,
      TXKEYED: true,
      TX_SOURCE: 'system',
      TYPE: 'HUB',
    },
  })

  assert.equal(expired['1900'].DESC, 'Hub')
  assert.deepEqual(expired['1900'].LINK, ['1901'])
  assert.equal(expired['1900'].AUDIO, true)
  assert.equal(expired['1900'].ONLINE, false)
  assert.equal(expired['1900'].LISTENERS, 0)
  assert.equal(expired['1900'].TX_SOURCE, null)
  assert.deepEqual(expired['1900'].CONNS, {})
})

test('topology only draws configured links and does not relayout for connection state changes', () => {
  const disconnected = collectEdges({
    1900: { CONNS: {}, LINK: ['1901'] },
    1901: { CONNS: {}, LINK: [] },
    1902: { CONNS: {}, LINK: [] },
  })
  const connecting = collectEdges({
    1900: { CONNS: { 1901: { CSTATE: 'CONNECTING' } }, LINK: ['1901'] },
    1901: { CONNS: {}, LINK: [] },
    1902: { CONNS: { 1901: { CSTATE: 'CONNECTING' } }, LINK: [] },
  })
  const connected = collectEdges({
    1900: { CONNS: { 1901: { CSTATE: 'ESTABLISHED' } }, LINK: ['1901'] },
    1901: { CONNS: {}, LINK: [] },
    1902: { CONNS: { 1901: { CSTATE: 'ESTABLISHED' } }, LINK: [] },
  })
  const fixedConnected = collectEdges({
    1900: { CONNS: { 1901: { CSTATE: 'ESTABLISHED' } }, LINK: ['1901'] },
    1901: { CONNS: {}, LINK: [] },
    1902: { CONNS: {}, LINK: [] },
  })
  const elements = new Map([
    ['1900', { offsetHeight: 80, offsetWidth: 224 }],
    ['1901', { offsetHeight: 80, offsetWidth: 224 }],
    ['1902', { offsetHeight: 80, offsetWidth: 224 }],
  ])

  assert.deepEqual(disconnected, [{ connected: false, source: '1900', target: '1901' }])
  assert.deepEqual(connecting, [{ connected: false, source: '1900', target: '1901' }])
  assert.deepEqual(connected, [
    { connected: true, source: '1900', target: '1901' },
    { connected: true, source: '1901', target: '1902' },
  ])
  assert.equal(
    graphSignature(['1900', '1901', '1902'], disconnected, elements, false),
    graphSignature(['1900', '1901', '1902'], fixedConnected, elements, false),
  )
  assert.notEqual(
    graphSignature(['1900', '1901', '1902'], disconnected, elements, false),
    graphSignature(['1900', '1901', '1902'], connected, elements, false),
  )
})
