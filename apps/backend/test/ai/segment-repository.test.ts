import type { SegmentRecord } from '../../src/ai/segment-store.js'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { SegmentRepository } from '../../src/ai/segment-repository.js'

function record(overrides: Partial<SegmentRecord> = {}): SegmentRecord {
  return {
    corrected: 'Bravo Golf Five X-ray X-ray X-ray',
    durationMs: 6_000,
    id: 'segment-1',
    payloads: [],
    recognition: '这里是 BG5XXX',
    timestamp: '2026-08-11T12:00:00.000Z',
    voicedMs: 5_500,
    ...overrides,
  }
}

test('persists ASR and later LLM results in one row', () => {
  const repository = new SegmentRepository(':memory:')
  const segment = record()
  repository.insert('1900', segment)

  assert.deepEqual(repository.find(segment.id), {
    callsign: null,
    capturedAt: segment.timestamp,
    corrected: segment.corrected,
    createdAt: repository.find(segment.id)?.createdAt,
    durationMs: 6_000,
    effectiveCallsign: null,
    effectiveRiskLevel: null,
    id: segment.id,
    manualCallsign: null,
    manualNote: null,
    manualRiskLevel: null,
    nodeId: '1900',
    recognition: segment.recognition,
    revise: null,
    riskLevel: null,
    riskReason: null,
    voicedMs: 5_500,
  })

  segment.revise = '这里是 BG5XXX。'
  segment.callsign = 'BG5XXX'
  segment.risk = { level: 2, reason: '轻微不适宜' }
  assert.equal(repository.updateAnalysis(segment), true)

  const persisted = repository.find(segment.id)
  assert.equal(persisted?.revise, '这里是 BG5XXX。')
  assert.equal(persisted?.callsign, 'BG5XXX')
  assert.equal(persisted?.riskLevel, 2)
  assert.equal(persisted?.riskReason, '轻微不适宜')
  assert.equal(persisted?.effectiveCallsign, 'BG5XXX')
  assert.equal(persisted?.effectiveRiskLevel, 2)
  repository.close()
})

test('manual review takes precedence without overwriting AI results', () => {
  const repository = new SegmentRepository(':memory:')
  const segment = record({ callsign: 'BG5XXX', risk: { level: 4, reason: '明显不当' } })
  repository.insert('1900', segment)
  repository.updateAnalysis(segment)

  assert.equal(repository.updateManualReview(segment.id, {
    callsign: 'BG5ABC',
    note: '人工复听确认',
    riskLevel: 1,
  }), true)

  const reviewed = repository.find(segment.id)
  assert.equal(reviewed?.callsign, 'BG5XXX')
  assert.equal(reviewed?.riskLevel, 4)
  assert.equal(reviewed?.manualCallsign, 'BG5ABC')
  assert.equal(reviewed?.manualRiskLevel, 1)
  assert.equal(reviewed?.manualNote, '人工复听确认')
  assert.equal(reviewed?.effectiveCallsign, 'BG5ABC')
  assert.equal(reviewed?.effectiveRiskLevel, 1)

  repository.updateManualReview(segment.id, { callsign: null, riskLevel: null })
  const cleared = repository.find(segment.id)
  assert.equal(cleared?.effectiveCallsign, 'BG5XXX')
  assert.equal(cleared?.effectiveRiskLevel, 4)
  repository.close()
})

test('persists data across repository instances and creates no explicit indexes', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'iaxweb-sqlite-'))
  t.after(() => rmSync(directory, { force: true, recursive: true }))
  const databaseFile = join(directory, 'ai.sqlite')

  const first = new SegmentRepository(databaseFile)
  first.insert('1999', record())
  first.close()

  const second = new SegmentRepository(databaseFile)
  assert.equal(second.find('segment-1')?.nodeId, '1999')
  second.close()

  const database = new DatabaseSync(databaseFile, { readOnly: true })
  const indexes = database.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%'
  `).all()
  assert.deepEqual(indexes, [])
  database.close()
})

test('enforces risk levels and rejects empty manual patches', () => {
  const repository = new SegmentRepository(':memory:')
  const segment = record()
  repository.insert('1900', segment)

  assert.throws(
    () => repository.updateManualReview(segment.id, { riskLevel: 6 }),
    /CHECK constraint failed/,
  )
  assert.throws(
    () => repository.updateManualReview(segment.id, {}),
    /at least one field/,
  )
  assert.equal(repository.updateManualReview('missing', { note: '不存在' }), false)
  repository.close()
})

test('returns the newest effective spot per callsign and excludes N0CALL', () => {
  const repository = new SegmentRepository(':memory:')
  const first = record({ callsign: 'BG5AAA', id: 'one', timestamp: '2026-08-10T12:00:00.000Z' })
  const second = record({ callsign: 'BG5AAA', id: 'two', timestamp: '2026-08-11T12:00:00.000Z' })
  const reviewed = record({ callsign: 'BG5BBB', id: 'three', timestamp: '2026-08-12T12:00:00.000Z' })
  repository.insert('1900', first)
  repository.insert('1901', second)
  repository.insert('1902', reviewed)
  repository.updateAnalysis(first)
  repository.updateAnalysis(second)
  repository.updateAnalysis(reviewed)
  repository.updateManualReview(reviewed.id, { callsign: 'N0CALL' })

  assert.deepEqual(repository.recentSpots(), [{
    at: second.timestamp,
    callsign: 'BG5AAA',
    id: second.id,
    node: '1901',
  }])
  repository.close()
})

test('lists segments newest first with pagination', () => {
  const repository = new SegmentRepository(':memory:')
  const old = record({ id: 'old', timestamp: '2026-08-10T12:00:00.000Z' })
  const latest = record({ id: 'latest', timestamp: '2026-08-12T12:00:00.000Z' })
  repository.insert('1900', old)
  repository.insert('1901', latest)

  const result = repository.list(1, 1)
  assert.equal(result.total, 2)
  assert.equal(result.items[0]?.id, 'latest')
  assert.deepEqual(repository.list(2, 1).items.map(item => item.id), ['old'])
  assert.throws(() => repository.list(0, 50), /Invalid segment page/)
  repository.close()
})

test('filters pages by exact effective callsign without case sensitivity', () => {
  const repository = new SegmentRepository(':memory:')
  const firstMatch = record({ callsign: 'BG5AAA', id: 'first-match', timestamp: '2026-08-10T12:00:00.000Z' })
  const overridden = record({ callsign: 'BG5AAA', id: 'overridden', timestamp: '2026-08-11T12:00:00.000Z' })
  const latestMatch = record({ callsign: 'BG5AAA', id: 'latest-match', timestamp: '2026-08-12T12:00:00.000Z' })
  for (const segment of [firstMatch, overridden, latestMatch]) {
    repository.insert('1900', segment)
    repository.updateAnalysis(segment)
  }
  repository.updateManualReview(overridden.id, { callsign: 'BG5BBB' })

  const result = repository.list(1, 50, 'bg5aaa')
  assert.equal(result.total, 2)
  assert.deepEqual(result.items.map(item => item.id), ['latest-match', 'first-match'])
  assert.equal(repository.list(1, 50, 'BG5BBB').items[0]?.id, 'overridden')
  assert.equal(repository.list(1, 50, 'BG5AA').total, 0)
  repository.close()
})
