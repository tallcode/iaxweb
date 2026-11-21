import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { manualRecognitionSchema, updateUserSchema } from '@iaxweb/contracts'
import { compileSchema } from '../../src/ai/schema-validator.js'

test('validates the shipped draft-2020 schema and advanced constraints', () => {
  const schema = JSON.parse(readFileSync(new URL('../../../../examples/ai/schema.json', import.meta.url), 'utf8'))
  const validate = compileSchema(schema)
  const empty = { selfCallsignEvidence: null, spelledCallsignEvidence: [], selfCallsign: null, spelledCallsigns: [] }
  assert.equal(validate(empty), undefined)
  assert.ok(validate({ speaker: 'other' }))
  assert.ok(validate({ ...empty, matchedCallsign: 'BG5AAA' }))
  const array = compileSchema({ type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', maxLength: 3 } })
  assert.equal(array(['ABC']), undefined)
  assert.ok(array(['ABCD']))
  assert.ok(array(['ABC', 'ABC']))
  assert.throws(() => compileSchema({ type: 'object', misspelledKeyword: true }))
})

test('accepts at most 1000 characters of manually reviewed text', () => {
  assert.equal(manualRecognitionSchema.safeParse({ recognition: '中'.repeat(1000) }).success, true)
  assert.equal(manualRecognitionSchema.safeParse({ recognition: '中'.repeat(1001) }).success, false)
  assert.equal(manualRecognitionSchema.parse({ recognition: '   ' }).recognition, null)
})

test('a password-only user patch does not assign a default role', () => {
  assert.deepEqual(updateUserSchema.parse({ password: 'new-password' }), { password: 'new-password' })
})
