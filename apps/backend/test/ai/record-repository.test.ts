import type { SegmentRecord } from '../../src/ai/segment-store.js'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { RecordRepository } from '../../src/ai/record-repository.js'

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
  const repository = new RecordRepository(':memory:')
  const segment = record()
  repository.insert('1900', segment)

  assert.deepEqual(repository.find(segment.id), {
    calleeCallsign: null,
    callsign: null,
    capturedAt: segment.timestamp,
    corrected: segment.corrected,
    createdAt: repository.find(segment.id)?.createdAt,
    durationMs: 6_000,
    effectiveCallsign: null,
    effectiveRiskLevel: null,
    id: segment.id,
    manualCallsign: null,
    manualRecognition: null,
    manualNote: null,
    manualRiskLevel: null,
    nodeId: '1900',
    recognition: segment.recognition,
    reviewed: false,
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
  const repository = new RecordRepository(':memory:')
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

test('keeps manual text and review status independent of AI analysis', () => {
  const repository = new RecordRepository(':memory:')
  const segment = record({ callsign: 'BG5AAA' })
  repository.insert('1900', segment)
  repository.updateManualReview(segment.id, { recognition: ' 人工复听文本 ', reviewed: true })
  repository.updateAnalysis(segment)
  assert.equal(repository.find(segment.id)?.recognition, segment.recognition)
  assert.equal(repository.find(segment.id)?.manualRecognition, '人工复听文本')
  assert.equal(repository.list(1, 50).items[0]?.reviewed, true)
  repository.updateManualReview(segment.id, { reviewed: false })
  assert.equal(repository.find(segment.id)?.reviewed, false)
  assert.equal(repository.find(segment.id)?.manualRecognition, '人工复听文本')
  repository.updateManualReview(segment.id, { recognition: '   ' })
  assert.equal(repository.find(segment.id)?.manualRecognition, null)
  repository.close()
})

test('migrates old databases without losing AI or manual callsign evidence', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'iaxweb-review-migration-'))
  t.after(() => rmSync(directory, { force: true, recursive: true }))
  const databaseFile = join(directory, 'old.sqlite')
  const old = new DatabaseSync(databaseFile)
  old.exec(`
    CREATE TABLE ai_segments (
      id TEXT PRIMARY KEY, node_id TEXT, captured_at TEXT, duration_ms INTEGER,
      voiced_ms INTEGER, recognition TEXT, corrected TEXT, revise TEXT,
      callsign TEXT, risk_level INTEGER, risk_reason TEXT, manual_callsign TEXT,
      callee_callsign TEXT, manual_risk_level INTEGER, manual_note TEXT, created_at TEXT
    );
    CREATE VIEW ai_segments_effective AS SELECT *,
      COALESCE(manual_callsign, callsign) AS effective_callsign,
      COALESCE(manual_risk_level, risk_level) AS effective_risk_level FROM ai_segments;
    INSERT INTO ai_segments (id, node_id, captured_at, duration_ms, voiced_ms,
      recognition, callsign, manual_callsign, created_at)
    VALUES ('old', '1900', '2026-11-14T00:00:00Z', 1000, 900,
      'AI 原文', 'BG5AAA', 'BG5BBB', '2026-11-14T00:00:00Z');
  `)
  old.close()
  const repository = new RecordRepository(databaseFile)
  assert.equal(repository.find('old')?.recognition, 'AI 原文')
  assert.equal(repository.find('old')?.effectiveCallsign, 'BG5BBB')
  assert.equal(repository.find('old')?.manualRecognition, null)
  assert.equal(repository.find('old')?.reviewed, false)
  repository.updateManualReview('old', { recognition: '人工文本', reviewed: true })
  repository.close()
  const reopened = new RecordRepository(databaseFile)
  assert.equal(reopened.find('old')?.manualRecognition, '人工文本')
  assert.equal(reopened.find('old')?.reviewed, true)
  reopened.close()
})

test('persists a manually reviewed callee callsign without changing AI analysis', () => {
  const repository = new RecordRepository(':memory:')
  const segment = record({ callsign: 'BG5AAA' })
  repository.insert('1900', segment)
  repository.updateAnalysis(segment)

  assert.equal(repository.updateManualReview(segment.id, { calleeCallsign: 'BG5BBB' }), true)
  const reviewed = repository.find(segment.id)
  assert.equal(reviewed?.calleeCallsign, 'BG5BBB')
  assert.equal(reviewed?.callsign, 'BG5AAA')
  repository.close()
})

test('persists data across repository instances and indexes ordered history queries', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'iaxweb-sqlite-'))
  t.after(() => rmSync(directory, { force: true, recursive: true }))
  const databaseFile = join(directory, 'ai.sqlite')

  const first = new RecordRepository(databaseFile)
  first.insert('1999', record())
  first.close()

  const second = new RecordRepository(databaseFile)
  assert.equal(second.find('segment-1')?.nodeId, '1999')
  second.close()

  const database = new DatabaseSync(databaseFile, { readOnly: true })
  for (const condition of [
    '',
    'WHERE effective_callsign = ? COLLATE NOCASE',
    'WHERE manual_recognition IS NOT NULL OR manual_callsign IS NOT NULL OR callee_callsign IS NOT NULL',
    'WHERE reviewed = 1',
  ]) {
    const plan = database.prepare(`
      EXPLAIN QUERY PLAN SELECT * FROM ai_segments_effective ${condition}
      ORDER BY captured_at DESC, id DESC LIMIT 50
    `).all(...(condition.includes('?') ? ['BG5XXX'] : []))
    const details = plan.map(row => String(row.detail)).join('\n')
    assert.match(details, /USING INDEX/)
    assert.doesNotMatch(details, /TEMP B-TREE/)
  }
  database.close()
})

test('enforces risk levels and rejects empty manual patches', () => {
  const repository = new RecordRepository(':memory:')
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
  const repository = new RecordRepository(':memory:')
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
  const repository = new RecordRepository(':memory:')
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

test('deletes records and rolls back when recording removal fails', () => {
  const repository = new RecordRepository(':memory:')
  const segment = record({ callsign: 'BG5AAA' })
  repository.insert('1900', segment)
  repository.updateAnalysis(segment)
  repository.updateManualReview(segment.id, { recognition: '人工文本', reviewed: true })
  assert.throws(() => repository.delete(segment.id, () => {
    throw new Error('Recording permission denied')
  }), /Recording permission denied/)
  assert.equal(repository.find(segment.id)?.manualRecognition, '人工文本')
  assert.equal(repository.list(1, 50).total, 1)
  let removals = 0
  assert.equal(repository.delete(segment.id, () => removals++), true)
  assert.equal(removals, 1)
  assert.equal(repository.find(segment.id), undefined)
  assert.equal(repository.list(1, 50).total, 0)
  assert.deepEqual(repository.recentSpots(), [])
  assert.equal(repository.updateAnalysis(segment), false)
  assert.equal(repository.delete(segment.id, () => removals++), false)
  assert.equal(removals, 1)
  repository.close()
})

test('filters pages by exact effective callsign without case sensitivity', () => {
  const repository = new RecordRepository(':memory:')
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

test('filters edits across all editable fields independently from review status', () => {
  const repository = new RecordRepository(':memory:')
  for (const id of ['ai-only', 'text-edit', 'caller-edit', 'callee-edit', 'review-only', 'both', 'note-only']) {
    const segment = record({ callsign: 'BG5AAA', id })
    repository.insert('1900', segment)
    repository.updateAnalysis(segment)
  }
  repository.updateManualReview('text-edit', { recognition: '人工文本' })
  repository.updateManualReview('caller-edit', { callsign: 'BG5BBB' })
  repository.updateManualReview('callee-edit', { calleeCallsign: 'BG5CCC' })
  repository.updateManualReview('review-only', { reviewed: true })
  repository.updateManualReview('both', { recognition: '已编辑并复核', reviewed: true })
  repository.updateManualReview('note-only', { note: '仅备注', riskLevel: 1 })

  const edited = repository.list(1, 50, undefined, true)
  assert.equal(edited.total, 4)
  assert.deepEqual(edited.items.map(item => item.id), ['text-edit', 'caller-edit', 'callee-edit', 'both'])
  assert.deepEqual(repository.list(1, 50, undefined, false, true).items.map(item => item.id), ['review-only', 'both'])
  assert.deepEqual(repository.list(1, 50, undefined, true, true).items.map(item => item.id), ['both'])
  assert.equal(repository.list(1, 50, 'bg5aaa', true).total, 3)
  assert.equal(repository.list(1, 50, 'bg5bbb', true).items[0]?.id, 'caller-edit')
  assert.equal(repository.list(1, 50, 'BG5BBB', true, true).total, 0)
  assert.equal(repository.list(1, 50, 'BG5AAA', false, true).total, 2)

  const firstPage = repository.list(1, 2, undefined, true)
  assert.equal(firstPage.total, 4)
  assert.deepEqual(firstPage.items.map(item => item.id), ['text-edit', 'caller-edit'])
  assert.deepEqual(repository.list(2, 2, undefined, true).items.map(item => item.id), ['callee-edit', 'both'])
  repository.updateManualReview('text-edit', { recognition: null })
  repository.updateManualReview('caller-edit', { callsign: null })
  repository.updateManualReview('callee-edit', { calleeCallsign: null })
  assert.deepEqual(repository.list(1, 50, undefined, true).items.map(item => item.id), ['both'])
  repository.updateManualReview('both', { reviewed: false })
  assert.equal(repository.list(1, 50, undefined, true, true).total, 0)
  assert.equal(repository.list(1, 50, undefined, true).total, 1)
  repository.close()
})
