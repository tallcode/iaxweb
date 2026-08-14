import assert from 'node:assert/strict'
import test from 'node:test'
import { LoginRateLimiter } from '../../src/admin/login-rate-limiter.js'

test('limits attempts by any supplied login dimension and resets after success', () => {
  let now = 1_000
  const limiter = new LoginRateLimiter({ maxAttempts: 2, now: () => now, windowMs: 10_000 })
  const keys = ['address:127.0.0.1', 'username:admin']

  assert.equal(limiter.consume(keys), undefined)
  assert.equal(limiter.consume(keys), undefined)
  assert.equal(limiter.consume(keys), 10_000)
  limiter.reset(keys)
  assert.equal(limiter.consume(keys), undefined)

  now += 10_001
  assert.equal(limiter.consume(keys), undefined)
})

test('shared usernames are limited across different addresses', () => {
  const limiter = new LoginRateLimiter({ maxAttempts: 1 })
  assert.equal(limiter.consume(['address:first', 'username:admin']), undefined)
  assert.ok(limiter.consume(['address:second', 'username:admin']))
})
