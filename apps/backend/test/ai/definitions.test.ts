import assert from 'node:assert/strict'
import test from 'node:test'

import { parseNodeDefinitions } from '../../src/allmon3/definitions.js'

test('parses the AI flag', () => {
  const definitions = parseNodeDefinitions({
    1900: { AI: true, AUDIO: true, NAME: '浙江HUB', TYPE: 'HUB' },
  })
  assert.equal(definitions['1900']?.AI, true)
})

test('allows AI false without audio', () => {
  const definitions = parseNodeDefinitions({
    1901: { AI: false, TYPE: 'REPEATER' },
  })
  assert.equal(definitions['1901']?.AI, false)
})

test('rejects AI without AUDIO', () => {
  assert.throws(
    () => parseNodeDefinitions({ 1900: { AI: true, TYPE: 'HUB' } }),
    /must have AUDIO true to enable AI/,
  )
})

test('rejects a non-boolean AI flag', () => {
  assert.throws(
    () => parseNodeDefinitions({ 1900: { AI: 'yes', AUDIO: true, TYPE: 'HUB' } }),
    /invalid AI/,
  )
})
