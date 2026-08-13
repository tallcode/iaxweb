import type { SegmentRecord } from '../../src/ai/segment-store.js'
import assert from 'node:assert/strict'

import test from 'node:test'
import { SegmentStore } from '../../src/ai/segment-store.js'

function makeRecord(overrides: Partial<SegmentRecord> = {}): SegmentRecord {
  return {
    durationMs: 6_000,
    id: 'test-id',
    payloads: [],
    timestamp: '2026-08-09T12:00:00.000Z',
    voicedMs: 6_000,
    ...overrides,
  }
}

test('recent is empty before any segment', () => {
  const store = new SegmentStore(300_000)
  assert.deepEqual(store.recent(), [])
  assert.equal(store.asrContext(), undefined)
  assert.equal(store.llmHistory(), undefined)
})

test('accumulates stage fields on the same record', () => {
  const store = new SegmentStore(300_000)
  const record = makeRecord()
  store.add(record)

  // Later stages mutate the record; the store reflects it.
  record.recognition = '原始文本'
  record.corrected = '纠错文本'
  record.revise = '规范化文本'
  record.callsign = 'BG5XXX'
  record.risk = { level: 1, reason: '正常' }

  assert.deepEqual(store.recent(), [record])
  assert.equal(store.asrContext(), '原始文本')
  assert.equal(store.recent()[0]?.corrected, '纠错文本')
  assert.equal(store.llmHistory(), '规范化文本')
})

test('llmHistory falls back to the raw recognition without a revise', () => {
  const store = new SegmentStore(300_000)
  store.add(makeRecord({ recognition: '只有识别' }))
  assert.equal(store.llmHistory(), '只有识别')
})

test('llmHistory prefixes the risk level when set', () => {
  const store = new SegmentStore(300_000)
  const record = makeRecord({ recognition: '原始', callsign: 'BG5XXX' })
  record.revise = '规范文本'
  record.risk = { level: 4, reason: '涉政' }
  store.add(record)
  assert.equal(store.llmHistory(), '[风控4] 规范文本')
})

test('llmHistory keeps raw ASR plus changed Bravo or Boston corrections', () => {
  const store = new SegmentStore(300_000)
  const record = makeRecord({
    recognition: '补拉窝 高尔夫 五',
    corrected: 'Bravo Golf Five',
    revise: '规范化文本',
  })
  store.add(record)

  assert.equal(store.llmHistory(), [
    '补拉窝 高尔夫 五',
    '音素纠错辅助文本（仅供判断）：',
    'Bravo Golf Five',
  ].join('\n'))
})

test('asrContext uses raw recognitions and llmHistory revised messages', () => {
  const store = new SegmentStore(300_000)
  const first = makeRecord({ id: 'a', recognition: '第一条原始' })
  first.revise = '第一条规范'
  store.add(first)
  // A segment whose ASR returned nothing contributes to neither.
  store.add(makeRecord({ id: 'b' }))
  const third = makeRecord({ id: 'c', recognition: '第三条原始' })
  third.revise = '第三条规范'
  store.add(third)

  assert.equal(store.asrContext(), '第一条原始\n第三条原始')
  assert.equal(store.llmHistory(), '第一条规范\n第三条规范')
})

test('expires records older than the window', () => {
  let time = 1_000_000
  const store = new SegmentStore(300_000, () => time)
  const old = makeRecord({ id: 'old', recognition: '旧的' })
  store.add(old)

  time += 299_000
  assert.equal(store.asrContext(), '旧的')

  time += 2_000
  assert.equal(store.asrContext(), undefined)
  assert.deepEqual(store.recent(), [])
})

test('trims context to the budget dropping oldest first', () => {
  const store = new SegmentStore(300_000)
  for (const word of ['甲', '乙', '丙'])
    store.add(makeRecord({ id: word, recognition: word.repeat(120) }))

  // All three joined are 362 chars; with a 300 char budget the oldest drops.
  const context = store.asrContext(300)
  assert.ok(context)
  assert.ok(context.length <= 300)
  assert.ok(!context.includes('甲'))
  assert.ok(context.includes('乙'))
  assert.ok(context.includes('丙'))
})

test('keeps the tail of a single oversize entry', () => {
  const store = new SegmentStore(300_000)
  store.add(makeRecord({ recognition: '头'.repeat(100) + '尾'.repeat(400) }))

  const context = store.asrContext(380)
  assert.ok(context)
  assert.equal(context.length, 380)
  assert.ok(context.endsWith('尾'.repeat(100)))
  assert.ok(!context.includes('头'))
})
