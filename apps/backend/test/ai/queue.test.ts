import assert from 'node:assert/strict'
import test from 'node:test'

import { SerialQueue } from '../../src/ai/queue.js'

test('runs jobs serially in order', async () => {
  const queue = new SerialQueue(10)
  const order: string[] = []
  queue.add(async () => {
    await new Promise(done => setTimeout(done, 10))
    order.push('a')
  })
  queue.add(async () => {
    order.push('b')
  })

  await new Promise(done => setTimeout(done, 50))
  assert.deepEqual(order, ['a', 'b'])
})

test('drops the oldest job beyond max depth', async () => {
  let overflows = 0
  const queue = new SerialQueue(2, () => overflows++)
  const order: string[] = []

  let releaseFirst: () => void = () => {}
  const blocked = new Promise<void>((done) => {
    releaseFirst = done
  })
  queue.add(async () => {
    await blocked
    order.push('a')
  })
  // While 'a' is running the queue holds at most 2 pending jobs.
  queue.add(async () => {
    order.push('b')
  })
  queue.add(async () => {
    order.push('c')
  })
  queue.add(async () => {
    order.push('d')
  }) // drops 'b'
  assert.equal(overflows, 1)

  releaseFirst()
  await new Promise(done => setTimeout(done, 20))
  assert.deepEqual(order, ['a', 'c', 'd'])
})

test('clear removes pending jobs', async () => {
  const queue = new SerialQueue(10)
  const order: string[] = []

  let releaseFirst: () => void = () => {}
  const blocked = new Promise<void>((done) => {
    releaseFirst = done
  })
  queue.add(async () => {
    await blocked
    order.push('a')
  })
  queue.add(async () => {
    order.push('b')
  })
  queue.clear()

  releaseFirst()
  await new Promise(done => setTimeout(done, 20))
  assert.deepEqual(order, ['a'])
  assert.equal(queue.pending, 0)
})

test('keeps draining after a job throws', async () => {
  const queue = new SerialQueue(10)
  const order: string[] = []
  queue.add(async () => {
    throw new Error('boom')
  })
  queue.add(async () => {
    order.push('after')
  })

  await new Promise(done => setTimeout(done, 20))
  assert.deepEqual(order, ['after'])
})
