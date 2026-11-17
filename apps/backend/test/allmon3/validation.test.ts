import assert from 'node:assert/strict'
import test from 'node:test'
import { SnapshotNotifier } from '../../src/allmon3/snapshot-notifier.js'
import { publicStatusSnapshot } from '../../src/allmon3/snapshot.js'
import { parseNodeStatus } from '../../src/allmon3/validation.js'

test('rejects malformed connection maps before they replace a valid upstream status', () => {
  assert.equal(parseNodeStatus({ CONNS: null }), undefined)
  assert.equal(parseNodeStatus({ CONNS: { 1901: null } }), undefined)
  assert.equal(parseNodeStatus({ RXKEYED: 'yes' }), undefined)
  const parsed = parseNodeStatus({ CONNS: { 1901: { CSTATE: 'ESTABLISHED', CTIME: 10 } }, RXKEYED: true })
  assert.ok(parsed)
  assert.deepEqual(publicStatusSnapshot({ 1900: parsed })['1900']?.CONNS, { 1901: { CSTATE: 'ESTABLISHED' } })
})

test('contains a failed async notification and allows later snapshots to be delivered', () => {
  let callback: () => void = () => {}
  let attempts = 0
  const notifier = new SnapshotNotifier(() => {
    attempts++
    if (attempts === 1)
      throw new Error('broadcast failure')
  }, 0, { set: (next) => {
    callback = next
    return next
  }, clear() {} })
  notifier.schedule({})
  assert.doesNotThrow(() => callback())
  notifier.schedule({})
  callback()
  assert.equal(attempts, 2)
})
