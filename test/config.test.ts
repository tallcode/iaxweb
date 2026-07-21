import assert from 'node:assert/strict'
import test from 'node:test'

import { loadConfig } from '../src/config.js'

test('loads defaults', () => {
  const config = loadConfig({})
  assert.equal(config.port, 3000)
  assert.equal(config.allmon3.baseUrl, 'http://172.16.211.199/allmon3/')
  assert.deepEqual(config.nats.servers, ['nats://127.0.0.1:4222'])
  assert.equal(config.nats.subjectRoot, 'iaxmon.nodes')
})

test('normalizes the Allmon3 base URL', () => {
  const config = loadConfig({ ALLMON3_BASE_URL: 'https://allmon.example/allmon3' })
  assert.equal(config.allmon3.baseUrl, 'https://allmon.example/allmon3/')
})

test('loads a NATS cluster and username authentication', () => {
  const config = loadConfig({
    NATS_SERVERS: 'nats://one:4222, nats://two:4222',
    NATS_SUBJECT_ROOT: 'radio.audio',
    NATS_USERNAME: 'gateway',
    NATS_PASSWORD: 'secret',
  })

  assert.deepEqual(config.nats.servers, ['nats://one:4222', 'nats://two:4222'])
  assert.equal(config.nats.subjectRoot, 'radio.audio')
  assert.equal(config.nats.username, 'gateway')
  assert.equal(config.nats.password, 'secret')
})

test('rejects conflicting NATS authentication', () => {
  assert.throws(() => loadConfig({
    NATS_USERNAME: 'gateway',
    NATS_PASSWORD: 'secret',
    NATS_TOKEN: 'token',
  }), /cannot be combined/)
})

test('rejects wildcard subjects', () => {
  assert.throws(
    () => loadConfig({ NATS_SUBJECT_ROOT: 'iaxmon.nodes.*' }),
    /valid subject root/,
  )
})

test('rejects empty subject tokens', () => {
  assert.throws(
    () => loadConfig({ NATS_SUBJECT_ROOT: 'iaxmon..nodes' }),
    /valid subject root/,
  )
})

test('rejects the legacy subject prefix with a migration error', () => {
  assert.throws(
    () => loadConfig({ NATS_SUBJECT_PREFIX: 'iaxmon.nodes.1999' }),
    /set NATS_SUBJECT_ROOT and remove NATS_SUBJECT_PREFIX/,
  )
})
