import type { SegmentRecord } from '../../src/ai/segment-store.js'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { SPEAKER_DIMENSIONS, SPEAKER_VERSION } from '../../src/ai/speaker-model.mjs'
import { RecordRepository } from '../../src/records/record-repository.js'

test('only reviewed records receive durable voiceprint jobs; cancellation keeps vectors', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'iaxweb-reviewed-embedding-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const filename = join(directory, 'ai.sqlite')
  const embedding = new Float32Array(SPEAKER_DIMENSIONS)
  embedding[0] = 1
  const first = new RecordRepository(filename)
  first.insert('1900', record())
  const inspect = new DatabaseSync(filename)
  assert.equal(inspect.prepare('SELECT COUNT(*) AS n FROM ai_segment_embeddings').get()?.n, 0)
  assert.equal(first.updateVoiceprint('segment-1', { status: 'ready', version: SPEAKER_VERSION, embedding }), false)
  first.updateManualReview('segment-1', { reviewed: true, callsign: 'BG5ABC' })
  assert.equal(first.pendingReviewedVoiceprints().length, 1)
  first.close()
  const reopened = new RecordRepository(filename)
  assert.equal(reopened.pendingReviewedVoiceprints().length, 1)
  assert.equal(reopened.prepareReviewedVoiceprint('segment-1'), true)
  assert.equal(reopened.updateVoiceprint('segment-1', { status: 'ready', version: SPEAKER_VERSION, embedding }), true)
  assert.equal(reopened.searchSpeakerMatches({ status: 'ready', version: SPEAKER_VERSION, embedding }, 'query').matches[0]?.callsign, 'BG5ABC')
  reopened.updateManualReview('segment-1', { reviewed: false })
  assert.deepEqual(reopened.searchSpeakerMatches({ status: 'ready', version: SPEAKER_VERSION, embedding }, 'query'), { referenceCount: 0, matches: [] })
  assert.equal(inspect.prepare('SELECT length(embedding) AS n FROM ai_segment_embeddings').get()?.n, SPEAKER_DIMENSIONS * 4)
  assert.equal(reopened.updateVoiceprint('segment-1', { status: 'failed', version: SPEAKER_VERSION }), false)
  reopened.updateManualReview('segment-1', { reviewed: true })
  assert.deepEqual(reopened.pendingReviewedVoiceprints(), [])
  reopened.delete('segment-1', () => {})
  assert.equal(inspect.prepare('SELECT COUNT(*) AS n FROM ai_segment_embeddings').get()?.n, 0)
  inspect.close()
  reopened.close()
})

test('quality reasons persist; cancelled or deleted jobs cannot save a vector', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'iaxweb-reviewed-quality-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const filename = join(directory, 'ai.sqlite')
  const repository = new RecordRepository(filename)
  repository.insert('1900', record())
  repository.updateManualReview('segment-1', { reviewed: true })
  repository.updateVoiceprint('segment-1', { status: 'unavailable', version: SPEAKER_VERSION, reason: 'interference_high_band' })
  repository.close()
  const reopened = new RecordRepository(filename)
  const inspect = new DatabaseSync(filename)
  const row = inspect.prepare('SELECT status, reason, embedding FROM ai_segment_embeddings').get()
  assert.equal(row?.status, 'unavailable')
  assert.equal(row?.reason, 'interference_high_band')
  assert.equal(row?.embedding, null)
  reopened.updateManualReview('segment-1', { reviewed: true })
  reopened.updateManualReview('segment-1', { reviewed: false })
  assert.equal(reopened.prepareReviewedVoiceprint('segment-1'), false)
  assert.equal(reopened.updateVoiceprint('segment-1', { status: 'failed', version: SPEAKER_VERSION }), false)
  reopened.delete('segment-1', () => {})
  assert.equal(reopened.updateVoiceprint('segment-1', { status: 'failed', version: SPEAKER_VERSION }), false)
  inspect.close()
  reopened.close()
})

test('SQL voice search uses current reviewed main callsigns, groups duplicates, and ignores time windows', () => {
  const repository = new RecordRepository(':memory:')
  const embedding = (cosine: number) => {
    const values = new Float32Array(SPEAKER_DIMENSIONS)
    values[0] = cosine
    values[1] = Math.sqrt(1 - cosine * cosine)
    return values
  }
  for (const [id, callsign, similarity] of [['a', 'BG5ABC', 0.99], ['b', 'BG5ABC', 0.95], ['c', 'BG5XYZ', 0.86], ['d', 'BG5LOW', 0.7999], ['e', 'N0CALL', 0.99]] as const) {
    repository.insert('1900', record({ id, timestamp: '2020-01-01T00:00:00Z' }))
    repository.updateManualReview(id, { reviewed: true, callsign, calleeCallsign: 'BG5ZZZ' })
    repository.updateVoiceprint(id, { status: 'ready', version: SPEAKER_VERSION, embedding: embedding(similarity) })
  }
  const query = { status: 'ready', version: SPEAKER_VERSION, embedding: embedding(1) } as const
  assert.deepEqual(repository.searchSpeakerMatches(query, 'query').matches.map(row => row.callsign), ['BG5ABC', 'BG5XYZ'])
  const stats = repository.searchSpeakerMatches(query, 'query')
  assert.equal(stats.referenceCount, 4)
  assert.equal(stats.matches[0]?.count, 2)
  assert.ok(Math.abs(stats.matches[0]!.maxSimilarity - 0.99) < 1e-6)
  assert.ok(Math.abs(stats.matches[0]!.minSimilarity - 0.95) < 1e-6)
  assert.ok(Math.abs(stats.matches[0]!.averageSimilarity - 0.97) < 1e-6)
  assert.equal(repository.searchSpeakerMatches(query, 'a').matches[0]?.count, 1)
  repository.updateManualReview('a', { callsign: 'BG5NEW' })
  assert.deepEqual(repository.searchSpeakerMatches(query, 'query').matches.map(row => row.callsign), ['BG5NEW', 'BG5ABC', 'BG5XYZ'])
  repository.updateManualReview('c', { reviewed: false })
  assert.deepEqual(repository.searchSpeakerMatches(query, 'query').matches.map(row => row.callsign), ['BG5NEW', 'BG5ABC'])
  assert.deepEqual(repository.searchSpeakerMatches({ ...query, version: 'legacy' }, 'query'), { referenceCount: 0, matches: [] })
  assert.deepEqual(repository.searchSpeakerMatches({ status: 'unavailable', version: SPEAKER_VERSION }, 'query'), { referenceCount: 0, matches: [] })
  repository.close()
})

test('legacy embedding tables gain the reason column and keep unreviewed stored data', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'iaxweb-embedding-upgrade-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const filename = join(directory, 'ai.sqlite')
  const first = new RecordRepository(filename)
  first.insert('1900', record())
  first.updateManualReview('segment-1', { reviewed: true })
  first.updateVoiceprint('segment-1', { status: 'unavailable', version: SPEAKER_VERSION, reason: 'interference_tone' })
  first.updateManualReview('segment-1', { reviewed: false })
  first.close()
  const legacy = new DatabaseSync(filename)
  legacy.exec('ALTER TABLE ai_segment_embeddings DROP COLUMN reason')
  legacy.close()
  const upgraded = new RecordRepository(filename)
  const inspect = new DatabaseSync(filename)
  assert.equal(inspect.prepare('SELECT status FROM ai_segment_embeddings').get()?.status, 'unavailable')
  assert.ok(inspect.prepare('PRAGMA table_info(ai_segment_embeddings)').all().some(row => row.name === 'reason'))
  inspect.close()
  upgraded.close()
})

test('legacy vectors are cleared once without an automatic backup; only reviewed rows are rebuilt as 768-byte vectors', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'iaxweb-model-upgrade-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const filename = join(directory, 'ai.sqlite')
  const initial = new RecordRepository(filename)
  initial.insert('1900', record({ id: 'reviewed' }))
  initial.insert('1900', record({ id: 'cancelled' }))
  initial.close()
  const database = new DatabaseSync(filename)
  database.exec(`
    DROP TABLE ai_segment_embeddings;
    CREATE TABLE ai_segment_embeddings (
      record_id TEXT PRIMARY KEY REFERENCES ai_segments(id) ON DELETE CASCADE,
      version TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'unavailable', 'failed')),
      embedding BLOB,
      CHECK ((status = 'ready' AND embedding IS NOT NULL AND length(embedding) = 1024)
        OR (status != 'ready' AND embedding IS NULL))
    );
    UPDATE ai_segments SET reviewed = 1 WHERE id = 'reviewed';
  `)
  const legacy = new Uint8Array(new Float32Array(256).fill(0.0625).buffer)
  for (const id of ['reviewed', 'cancelled'])
    database.prepare('INSERT INTO ai_segment_embeddings VALUES (?, ?, ?, ?)').run(id, 'wespeaker-legacy', 'ready', legacy)
  const upgraded = new RecordRepository(filename)
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM ai_segment_embeddings').get()?.n, 0)
  assert.equal(upgraded.find('cancelled')?.reviewed, false)
  assert.equal(upgraded.find('reviewed')?.reviewed, true)
  assert.deepEqual(upgraded.pendingReviewedVoiceprints().map(row => row.id), ['reviewed'])
  assert.equal(upgraded.prepareReviewedVoiceprint('reviewed'), true)
  const embedding = new Float32Array(SPEAKER_DIMENSIONS)
  embedding[0] = 1
  assert.equal(upgraded.updateVoiceprint('reviewed', { status: 'ready', version: SPEAKER_VERSION, embedding }), true)
  assert.equal(database.prepare('SELECT length(embedding) AS n FROM ai_segment_embeddings WHERE record_id = ?').get('reviewed')?.n, SPEAKER_DIMENSIONS * 4)
  assert.equal(database.prepare('SELECT embedding FROM ai_segment_embeddings WHERE record_id = ?').get('cancelled'), undefined)
  assert.throws(() => database.prepare('UPDATE ai_segment_embeddings SET embedding = ? WHERE record_id = ?').run(legacy, 'reviewed'))
  assert.throws(() => database.prepare('UPDATE ai_segment_embeddings SET dimensions = 256 WHERE record_id = ?').run('reviewed'))
  assert.equal(upgraded.searchSpeakerMatches({ status: 'ready', version: SPEAKER_VERSION, embedding }, 'query').referenceCount, 1)
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
  assert.equal(existsSync(join(directory, 'backups')), false)
  upgraded.close()
  const reopened = new RecordRepository(filename)
  assert.deepEqual(reopened.pendingReviewedVoiceprints(), [])
  assert.equal(existsSync(join(directory, 'backups')), false)
  reopened.delete('cancelled', () => {})
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM ai_segment_embeddings WHERE record_id = ?').get('cancelled')?.n, 0)
  reopened.close()
  database.close()
})

test('resource policy upgrade retries only eligible legacy limit rejections once', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'iaxweb-resource-policy-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const filename = join(directory, 'ai.sqlite')
  const first = new RecordRepository(filename)
  for (const [id, reason] of [
    ['legacy-time', 'audio_too_long'],
    ['legacy-memory', 'resource_limit'],
    ['quality', 'interference_high_band'],
    ['new-limit', 'resource_limit_2g'],
    ['cancelled', 'resource_limit'],
    ['over-minute', 'audio_too_long'],
  ] as const) {
    first.insert('1900', record({ id, durationMs: id === 'over-minute' ? 61_000 : 30_000 }))
    first.updateManualReview(id, { reviewed: true })
    first.updateVoiceprint(id, { status: 'unavailable', version: SPEAKER_VERSION, reason })
  }
  first.updateManualReview('cancelled', { reviewed: false })
  first.close()
  const upgraded = new RecordRepository(filename)
  assert.deepEqual(upgraded.pendingReviewedVoiceprints().map(row => row.id).sort(), ['legacy-memory', 'legacy-time'])
  assert.equal(upgraded.prepareReviewedVoiceprint('legacy-memory'), true)
  upgraded.updateVoiceprint('legacy-memory', { status: 'unavailable', version: SPEAKER_VERSION, reason: 'resource_limit_2g' })
  upgraded.close()
  const reopened = new RecordRepository(filename)
  assert.deepEqual(reopened.pendingReviewedVoiceprints().map(row => row.id), ['legacy-time'])
  assert.equal(reopened.find('cancelled')?.reviewed, false)
  reopened.close()
})

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
