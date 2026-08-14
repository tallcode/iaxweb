import assert from 'node:assert/strict'
import test from 'node:test'
import { isExpectedWebSocketClose } from '../../src/gateway/websocket-heartbeat.js'

test('classifies normal and browser-aborted WebSocket closes as expected', () => {
  assert.equal(isExpectedWebSocketClose(1000), true)
  assert.equal(isExpectedWebSocketClose(1001), true)
  assert.equal(isExpectedWebSocketClose(1005), true)
  assert.equal(isExpectedWebSocketClose(1006), true)
  assert.equal(isExpectedWebSocketClose(1008), false)
  assert.equal(isExpectedWebSocketClose(1011), false)
})
