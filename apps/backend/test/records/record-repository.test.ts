import type { SpotEvent } from '@iaxweb/contracts'
import type { SegmentRecord } from '../../src/ai/segment-store.js'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { SPEAKER_DIMENSIONS, SPEAKER_VERSION } from '../../src/ai/speaker-model.mjs'
import { RecordRepository } from '../../src/records/record-repository.js'
import { RecordReviewService } from '../../src/records/review-service.js'

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

test('review requires a caller and rejected patches do not create jobs or clear existing values', () => {
  const repository = new RecordRepository(':memory:')
  repository.insert('1900', record())
  assert.equal(repository.updateManualReview('segment-1', { reviewed: true }), false)
  assert.equal(repository.find('segment-1')?.reviewed, false)
  assert.deepEqual(repository.pendingReviewedVoiceprints(), [])
  assert.equal(repository.updateManualReview('segment-1', { reviewed: true, callsign: 'BG5ABC' }), true)
  assert.equal(repository.updateManualReview('segment-1', { callsign: null }), false)
  assert.equal(repository.find('segment-1')?.manualCallsign, 'BG5ABC')
  assert.equal(repository.find('segment-1')?.reviewed, true)
  assert.equal(repository.updateManualReview('segment-1', { reviewed: false }), true)
  assert.equal(repository.updateManualReview('segment-1', { callsign: null }), true)
  repository.close()
})

test('reviewed AI-only callers are searchable and manual callers override them', () => {
  const repository = new RecordRepository(':memory:')
  const segment = record({ callsign: 'BG5ABC' })
  repository.insert('1900', segment)
  repository.updateAutomaticCallsign(segment)
  assert.equal(repository.updateManualReview(segment.id, { reviewed: true }), true)
  assert.equal(repository.find(segment.id)?.manualCallsign, null)
  const embedding = new Float32Array(SPEAKER_DIMENSIONS)
  embedding[0] = 1
  const voiceprint = { status: 'ready', version: SPEAKER_VERSION, embedding } as const
  repository.updateVoiceprint(segment.id, voiceprint)
  assert.equal(repository.searchSpeakerMatches(voiceprint, 'query').matches[0]?.callsign, 'BG5ABC')
  repository.updateManualReview(segment.id, { callsign: 'BG5XYZ' })
  assert.equal(repository.searchSpeakerMatches(voiceprint, 'query').matches[0]?.callsign, 'BG5XYZ')
  assert.equal(repository.updateManualReview(segment.id, { callsign: null }), true)
  assert.equal(repository.searchSpeakerMatches(voiceprint, 'query').matches[0]?.callsign, 'BG5ABC')
  repository.close()
})

test('cached query vectors become searchable only while their recording is reviewed', () => {
  const repository = new RecordRepository(':memory:')
  try {
    const segment = record({ callsign: 'BG5ABC' })
    repository.insert('1900', segment)
    repository.updateAutomaticCallsign(segment)
    const embedding = new Float32Array(SPEAKER_DIMENSIONS)
    embedding[0] = 1
    const voiceprint = { status: 'ready', version: SPEAKER_VERSION, embedding } as const
    repository.saveQueryVoiceprint(segment.id, voiceprint)
    assert.deepEqual(repository.findReadyVoiceprint(segment.id), voiceprint)
    assert.deepEqual(repository.searchSpeakerMatches(voiceprint, 'other').matches, [])
    assert.equal(repository.updateManualReview(segment.id, { reviewed: true }), true)
    assert.deepEqual(repository.pendingReviewedVoiceprints(), [])
    assert.equal(repository.searchSpeakerMatches(voiceprint, 'other').matches[0]?.callsign, 'BG5ABC')
    assert.deepEqual(repository.searchSpeakerMatches(voiceprint, segment.id).matches, [])
    assert.equal(repository.updateManualReview(segment.id, { reviewed: false }), true)
    assert.deepEqual(repository.searchSpeakerMatches(voiceprint, 'other').matches, [])
    assert.deepEqual(repository.findReadyVoiceprint(segment.id), voiceprint)
  }
  finally { repository.close() }
})

test('quality reasons persist; cancelled or deleted jobs cannot save a vector', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'iaxweb-reviewed-quality-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const filename = join(directory, 'ai.sqlite')
  const repository = new RecordRepository(filename)
  repository.insert('1900', record())
  repository.updateManualReview('segment-1', { reviewed: true, callsign: 'BG5XXX' })
  repository.updateVoiceprint('segment-1', { status: 'unavailable', version: SPEAKER_VERSION, reason: 'interference_high_band' })
  repository.close()
  const reopened = new RecordRepository(filename)
  const inspect = new DatabaseSync(filename)
  const row = inspect.prepare('SELECT status, reason, embedding FROM ai_segment_embeddings').get()
  assert.equal(row?.status, 'unavailable')
  assert.equal(row?.reason, null)
  assert.equal(reopened.find('segment-1')?.audioQuality?.reason, 'interference_high_band')
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

test('reference templates use the latest sixteen eligible records, including below-threshold and AI-only callers', () => {
  const repository = new RecordRepository(':memory:')
  try {
    const vectors: Float32Array[] = []
    for (let index = 0; index < 18; index++) {
      const segment = record({ id: `ref-${index}`, timestamp: `2026-10-${String(index + 1).padStart(2, '0')}T00:00:00Z`, callsign: 'BG5ABC' })
      repository.insert('1900', segment)
      repository.updateAutomaticCallsign(segment)
      repository.updateManualReview(segment.id, { reviewed: true })
      const embedding = new Float32Array(SPEAKER_DIMENSIONS)
      embedding[0] = index / 25
      embedding[1] = Math.sqrt(1 - embedding[0]! ** 2)
      vectors.push(embedding)
      repository.updateVoiceprint(segment.id, { status: 'ready', version: SPEAKER_VERSION, embedding })
    }
    repository.updateManualReview('ref-17', { reviewed: false })
    repository.updateManualReview('ref-16', { callsign: 'BG5XYZ' })
    const references = repository.recentSpeakerReferences(['bg5abc', 'BG5XYZ', 'BG5NONE'], 'ref-15')
    assert.deepEqual(references[0]?.embeddings, vectors.slice(0, 15).reverse())
    assert.deepEqual(references[1]?.embeddings, [vectors[16]])
    assert.deepEqual(references[2]?.embeddings, [])
    repository.updateManualReview('ref-17', { reviewed: true })
    repository.updateManualReview('ref-16', { callsign: null })
    assert.deepEqual(repository.recentSpeakerReferences(['BG5ABC'], 'query')[0]?.embeddings, vectors.slice(2).reverse())
  }
  finally { repository.close() }
})

test('SQL voice search uses current reviewed main callsigns, groups duplicates, and ignores time windows', () => {
  const repository = new RecordRepository(':memory:')
  const embedding = (cosine: number) => {
    const values = new Float32Array(SPEAKER_DIMENSIONS)
    values[0] = cosine
    values[1] = Math.sqrt(1 - cosine * cosine)
    return values
  }
  for (const [id, callsign, similarity] of [['a', 'BG5ABC', 0.99], ['b', 'BG5ABC', 0.95], ['c', 'BG5XYZ', 0.81], ['d', 'BG5LOW', 0.7999], ['e', 'N0CALL', 0.99]] as const) {
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

test('the current schema enforces voiceprint dimensions and preserves stored vectors on reopen', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'iaxweb-embedding-schema-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const filename = join(directory, 'ai.sqlite')
  const initial = new RecordRepository(filename)
  initial.insert('1900', record({ id: 'reviewed' }))
  initial.updateManualReview('reviewed', { reviewed: true, callsign: 'BG5XXX' })
  const embedding = new Float32Array(SPEAKER_DIMENSIONS)
  embedding[0] = 1
  assert.equal(initial.updateVoiceprint('reviewed', { status: 'ready', version: SPEAKER_VERSION, embedding }), true)
  initial.close()

  const reopened = new RecordRepository(filename)
  const inspect = new DatabaseSync(filename)
  const previousEmbedding = new Uint8Array(new Float32Array(256).buffer)
  assert.throws(() => inspect.prepare('UPDATE ai_segment_embeddings SET embedding = ? WHERE record_id = ?').run(previousEmbedding, 'reviewed'))
  assert.throws(() => inspect.prepare('UPDATE ai_segment_embeddings SET dimensions = 256 WHERE record_id = ?').run('reviewed'))
  assert.deepEqual(inspect.prepare('PRAGMA foreign_key_check').all(), [])
  assert.deepEqual(reopened.findReadyVoiceprint('reviewed')?.embedding, embedding)
  assert.deepEqual(reopened.pendingReviewedVoiceprints(), [])
  inspect.close()
  reopened.close()
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
    first.updateManualReview(id, { reviewed: true, callsign: 'BG5XXX' })
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

test('persists ASR and the later automatic callsign in one row', () => {
  const repository = new RecordRepository(':memory:')
  const segment = record({ sourceRepeaterId: '1901' })
  repository.insert('1900', segment)

  assert.deepEqual(repository.find(segment.id), {
    calleeCallsign: null,
    callsign: null,
    callsignAlgorithm: null,
    signaling: null,
    audioQuality: null,
    capturedAt: segment.timestamp,
    corrected: segment.corrected,
    createdAt: repository.find(segment.id)?.createdAt,
    durationMs: 6_000,
    effectiveCallsign: null,
    id: segment.id,
    manualCallsign: null,
    manualRecognition: null,
    manualNote: null,
    nodeId: '1900',
    recognition: segment.recognition,
    reviewed: false,
    sourceRepeaterId: '1901',
    voicedMs: 5_500,
  })

  segment.callsign = 'BG5XXX'
  segment.callsignAlgorithm = 'stage2_feature'
  assert.equal(repository.updateAutomaticCallsign(segment), true)

  const persisted = repository.find(segment.id)
  assert.equal(persisted?.callsign, 'BG5XXX')
  assert.equal(persisted?.callsignAlgorithm, 'stage2_feature')
  assert.equal(persisted?.effectiveCallsign, 'BG5XXX')
  assert.equal(repository.list(1, 1).items[0]?.sourceRepeaterId, '1901')
  repository.close()
})

test('manual review takes precedence without overwriting AI results', () => {
  const repository = new RecordRepository(':memory:')
  const segment = record({ callsign: 'BG5XXX' })
  repository.insert('1900', segment)
  repository.updateAutomaticCallsign(segment)

  assert.equal(repository.updateManualReview(segment.id, {
    callsign: 'BG5ABC',
    note: '人工复听确认',
  }), true)

  const reviewed = repository.find(segment.id)
  assert.equal(reviewed?.callsign, 'BG5XXX')
  assert.equal(reviewed?.manualCallsign, 'BG5ABC')
  assert.equal(reviewed?.manualNote, '人工复听确认')
  assert.equal(reviewed?.effectiveCallsign, 'BG5ABC')
  repository.updateManualReview(segment.id, { callsign: null })
  const cleared = repository.find(segment.id)
  assert.equal(cleared?.effectiveCallsign, 'BG5XXX')
  repository.close()
})

test('keeps manual text and review status independent of automatic callsign updates', () => {
  const repository = new RecordRepository(':memory:')
  const segment = record({ callsign: 'BG5AAA' })
  repository.insert('1900', segment)
  repository.updateAutomaticCallsign(segment)
  repository.updateManualReview(segment.id, { recognition: ' 人工复听文本 ', reviewed: true })
  repository.updateAutomaticCallsign(segment)
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

test('keeps old SQLite evidence and only exposes current record fields', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'iaxweb-review-migration-'))
  t.after(() => rmSync(directory, { force: true, recursive: true }))
  const databaseFile = join(directory, 'old.sqlite')
  const old = new DatabaseSync(databaseFile)
  old.exec(`
    CREATE TABLE ai_segments (
      id TEXT PRIMARY KEY, node_id TEXT, captured_at TEXT, duration_ms INTEGER,
      voiced_ms INTEGER, recognition TEXT, corrected TEXT, revise TEXT,
      callsign TEXT, risk_level INTEGER, risk_reason TEXT, manual_callsign TEXT,
      callee_callsign TEXT, manual_risk_level INTEGER, manual_note TEXT, created_at TEXT,
      audio_quality TEXT
    );
    CREATE VIEW ai_segments_effective AS SELECT *,
      COALESCE(manual_callsign, callsign) AS effective_callsign,
      COALESCE(manual_risk_level, risk_level) AS effective_risk_level FROM ai_segments;
    INSERT INTO ai_segments (id, node_id, captured_at, duration_ms, voiced_ms,
      recognition, callsign, manual_callsign, created_at, revise, risk_level, risk_reason, manual_risk_level)
    VALUES ('old', '1900', '2026-11-14T00:00:00Z', 1000, 900,
      'AI 原文', 'BG5AAA', 'BG5BBB', '2026-11-14T00:00:00Z', '历史整理', 2, '历史原因', 1);
  `)
  old.close()
  const repository = new RecordRepository(databaseFile)
  assert.equal(repository.find('old')?.recognition, 'AI 原文')
  assert.equal(repository.find('old')?.effectiveCallsign, 'BG5BBB')
  assert.equal(repository.find('old')?.manualRecognition, null)
  assert.equal(repository.find('old')?.reviewed, false)
  assert.equal(repository.find('old')?.sourceRepeaterId, null)
  assert.equal(Object.hasOwn(repository.find('old')!, 'revise'), false)
  assert.equal(repository.updateAutomaticCallsign(record({ id: 'old', callsign: 'BG5CCC' })), true)
  repository.updateManualReview('old', { recognition: '人工文本', reviewed: true })
  repository.close()
  const reopened = new RecordRepository(databaseFile)
  assert.equal(reopened.find('old')?.manualRecognition, '人工文本')
  assert.equal(reopened.find('old')?.reviewed, true)
  assert.equal(reopened.list(1, 1).items[0]?.callsign, 'BG5CCC')
  assert.equal(reopened.find('old')?.effectiveCallsign, 'BG5BBB')
  reopened.close()
  const inspect = new DatabaseSync(databaseFile, { readOnly: true })
  assert.deepEqual({ ...inspect.prepare('SELECT revise, risk_level, risk_reason, manual_risk_level FROM ai_segments').get() }, {
    revise: '历史整理',
    risk_level: 2,
    risk_reason: '历史原因',
    manual_risk_level: 1,
  })
  inspect.close()
})

test('persists a manually reviewed callee callsign without changing the automatic caller', () => {
  const repository = new RecordRepository(':memory:')
  const segment = record({ callsign: 'BG5AAA' })
  repository.insert('1900', segment)
  repository.updateAutomaticCallsign(segment)

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
  assert.equal(second.find('segment-1')?.sourceRepeaterId, null)
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

test('rejects empty manual patches', () => {
  const repository = new RecordRepository(':memory:')
  const segment = record()
  repository.insert('1900', segment)

  assert.throws(
    () => repository.updateManualReview(segment.id, {}),
    /at least one field/,
  )
  assert.equal(repository.updateManualReview('missing', { note: '不存在' }), false)
  repository.close()
})

test('returns the newest effective spot per callsign and excludes N0CALL', () => {
  const repository = new RecordRepository(':memory:')
  const first = record({ callsign: 'BG5AAA', id: 'one', sourceRepeaterId: '1903', timestamp: '2026-08-10T12:00:00.000Z' })
  const second = record({ callsign: 'BG5AAA', id: 'two', sourceRepeaterId: '1904', timestamp: '2026-08-11T12:00:00.000Z' })
  const reviewed = record({ callsign: 'BG5BBB', id: 'three', timestamp: '2026-08-12T12:00:00.000Z' })
  const unknown = record({ callsign: 'BG5CCC', id: 'four', timestamp: '2026-08-09T12:00:00.000Z' })
  repository.insert('1900', first)
  repository.insert('1901', second)
  repository.insert('1902', reviewed)
  repository.insert('1900', unknown)
  repository.updateAutomaticCallsign(first)
  repository.updateAutomaticCallsign(second)
  repository.updateAutomaticCallsign(reviewed)
  repository.updateAutomaticCallsign(unknown)
  repository.updateManualReview(reviewed.id, { callsign: 'N0CALL' })

  assert.deepEqual(repository.recentSpots(), [{
    at: second.timestamp,
    callsign: 'BG5AAA',
    id: second.id,
    node: '1901',
    source: '1904',
  }, {
    at: unknown.timestamp,
    callsign: 'BG5CCC',
    id: unknown.id,
    node: '1900',
    source: null,
  }])
  repository.close()
})

test('published corrections and removals carry the recorded repeater source', (context) => {
  const repository = new RecordRepository(':memory:')
  context.after(() => repository.close())
  const segment = record({ sourceRepeaterId: '1901' })
  repository.insert('1900', segment)
  const published: SpotEvent[] = []
  const review = new RecordReviewService(repository, { remove() {} }, {
    publishReview: spot => published.push(spot),
  })

  review.update(segment.id, { callsign: 'BG5AAA' }, { role: 'editor', username: 'operator' })
  review.delete(segment.id)

  assert.deepEqual(published, [{
    at: segment.timestamp,
    callsign: 'BG5AAA',
    id: segment.id,
    node: '1900',
    source: '1901',
  }, {
    at: segment.timestamp,
    callsign: 'N0CALL',
    id: segment.id,
    node: '1900',
    source: '1901',
  }])
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
  repository.updateAutomaticCallsign(segment)
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
  assert.equal(repository.updateAutomaticCallsign(segment), false)
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
    repository.updateAutomaticCallsign(segment)
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
    repository.updateAutomaticCallsign(segment)
  }
  repository.updateManualReview('text-edit', { recognition: '人工文本' })
  repository.updateManualReview('caller-edit', { callsign: 'BG5BBB' })
  repository.updateManualReview('callee-edit', { calleeCallsign: 'BG5CCC' })
  repository.updateManualReview('review-only', { reviewed: true })
  repository.updateManualReview('both', { recognition: '已编辑并复核', reviewed: true })
  repository.updateManualReview('note-only', { note: '仅备注' })

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
