import type { NodeDefinitions, NodeStatus } from '../src/allmon3.js'

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildSnapshot, parseNodeDefinitions, statusFingerprint, transmitSource } from '../src/allmon3.js'

const definitions: NodeDefinitions = {
  1900: { LINK: ['1901'], TYPE: 'HUB' },
  1901: { FREQ: '145.400MHz/-0.6MHz/TSQ88.5Hz', NAME: 'BR5AI', TYPE: 'REPEATER' },
}

test('builds defaults immediately when live details are missing', () => {
  const details = new Map<string, NodeStatus>([
    ['1900', { DESC: 'Hub', ME: 1900, ONLINE: true }],
  ])
  const snapshot = buildSnapshot(new Set(['1900', '1901']), details, {}, definitions)

  assert.equal(snapshot['1900']?.TYPE, 'HUB')
  assert.deepEqual(snapshot['1900']?.LINK, ['1901'])
  assert.equal(snapshot['1901']?.ONLINE, false)
  assert.equal(snapshot['1901']?.TXKEYED, false)
  assert.equal(snapshot['1901']?.FREQ, '145.400MHz/-0.6MHz/TSQ88.5Hz')
  assert.equal(snapshot['1901']?.NAME, 'BR5AI')
})

test('builds a sorted snapshot and applies name overrides', () => {
  const details = new Map<string, NodeStatus>([
    ['1901', { DESC: 'Original', ME: 1901 }],
    ['1900', { DESC: 'Original', ME: 1900 }],
  ])
  const snapshot = buildSnapshot(
    new Set(['1901', '1900']),
    details,
    { 1900: '浙江省业余无线电协会链路HUB' },
    definitions,
  )

  assert.deepEqual(Object.keys(snapshot), ['1900', '1901'])
  assert.equal(snapshot['1900']?.DESC, '浙江省业余无线电协会链路HUB')
  assert.equal(snapshot['1901']?.DESC, 'Original')
})

test('validates static node definitions', () => {
  assert.deepEqual(parseNodeDefinitions({
    1900: { LINK: ['1901'], TYPE: 'HUB' },
    1901: { NAME: 'BR5AI', TYPE: 'REPEATER' },
  }), {
    1900: { LINK: ['1901'], TYPE: 'HUB' },
    1901: { NAME: 'BR5AI', TYPE: 'REPEATER' },
  })
  assert.throws(() => parseNodeDefinitions({ 1900: { TYPE: 'UNKNOWN' } }), /TYPE HUB or REPEATER/)
  assert.throws(() => parseNodeDefinitions({ 1900: { NAME: 1900, TYPE: 'HUB' } }), /invalid NAME/)
})

test('ignores continuously increasing timer fields when detecting changes', () => {
  const before = {
    1900: {
      CONNS: {
        1901: { CTIME: '01:00:00', PTT: '0', SSK: '10', SSU: '8' },
      },
      RELOADTIME: 100,
      UPTIME: 100,
    },
  }
  const after = {
    1900: {
      CONNS: {
        1901: { CTIME: '01:00:01', PTT: '0', SSK: '11', SSU: '9' },
      },
      RELOADTIME: 101,
      UPTIME: 101,
    },
  }
  assert.equal(statusFingerprint(before), statusFingerprint(after))
})

test('detects meaningful status changes', () => {
  const idle = { 1900: { RXKEYED: false, TXKEYED: false } }
  const transmitting = { 1900: { RXKEYED: true, TXKEYED: true } }
  assert.notEqual(statusFingerprint(idle), statusFingerprint(transmitting))
})

test('distinguishes local, remote, system and idle transmission', () => {
  assert.equal(transmitSource({ RXKEYED: true, TXKEYED: true }), 'local')
  assert.equal(transmitSource({ CONNKEYED: true, RXKEYED: false, TXKEYED: true }), 'remote')
  assert.equal(transmitSource({ CONNKEYED: false, RXKEYED: false, TXKEYED: true }), 'system')
  assert.equal(transmitSource({ RXKEYED: false, TXKEYED: false }), null)
  assert.equal(transmitSource({ ERROR: 'offline', TXKEYED: true }), null)
})
