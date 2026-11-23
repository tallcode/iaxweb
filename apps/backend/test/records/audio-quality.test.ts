import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { SPEAKER_DIMENSIONS, SPEAKER_VERSION } from '../../src/ai/speaker-model.mjs'
import { RecordRepository } from '../../src/records/record-repository.js'

test('opening existing history preserves saved quality assessments and cached embeddings', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'iaxweb-audio-quality-history-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = join(directory, 'history.sqlite')
  const before = new RecordRepository(file)
  const embedding = new Float32Array(SPEAKER_DIMENSIONS)
  embedding[0] = 1
  const metrics = { highBandFraction: 0.001, toneProminenceDb: 2, highBandRolloffDb: -10, highBandDynamicDb: 5 }
  for (const status of ['skip', 'passed', 'rejected', 'unknown'] as const) {
    before.insert('1900', { id: status, timestamp: '2026-11-22T01:00:00Z', durationMs: 2000, voicedMs: 1500, recognition: 'original' })
    before.updateManualReview(status, { reviewed: true, callsign: 'BG5XXX' })
    before.saveQueryVoiceprint(status, { status: 'ready', version: SPEAKER_VERSION, embedding })
    before.updateAudioQuality(status, { status, reason: status === 'unknown' ? 'check_timeout' : null, metrics: status === 'passed' ? metrics : null })
  }
  before.insert('1900', { id: 'no-vector', timestamp: '2026-11-22T01:00:00Z', durationMs: 2000, voicedMs: 1500, recognition: 'original', audioQuality: { status: 'skip', reason: null, metrics: null } })
  before.close()
  const raw = new DatabaseSync(file)
  const originalEmbeddings = raw.prepare('SELECT * FROM ai_segment_embeddings ORDER BY record_id').all()
  const originalQuality = raw.prepare('SELECT id, audio_quality FROM ai_segments ORDER BY id').all()
  const reopened = new RecordRepository(file)
  assert.deepEqual(reopened.find('skip')?.audioQuality, { status: 'skip', reason: null, metrics: null })
  assert.deepEqual(reopened.findReadyVoiceprint('skip'), { status: 'ready', version: SPEAKER_VERSION, embedding })
  assert.deepEqual(raw.prepare('SELECT * FROM ai_segment_embeddings ORDER BY record_id').all(), originalEmbeddings)
  assert.deepEqual(raw.prepare('SELECT id, audio_quality FROM ai_segments ORDER BY id').all(), originalQuality)
  assert.deepEqual(reopened.pendingReviewedVoiceprints(), [])
  reopened.close()
  raw.close()
})

test('record quality is independent of extraction failures and new rows do not inherit historical skip', () => {
  const repository = new RecordRepository(':memory:')
  try {
    repository.insert('1900', { id: 'new', timestamp: '2026-11-22T01:00:00Z', durationMs: 2000, voicedMs: 1500, recognition: 'ASR', audioQuality: { status: 'passed', reason: null, metrics: null } })
    repository.updateManualReview('new', { reviewed: true, callsign: 'BG5XXX' })
    repository.updateVoiceprint('new', { status: 'failed', version: SPEAKER_VERSION, reason: 'model_error' })
    assert.equal(repository.find('new')?.audioQuality?.status, 'passed')
    assert.equal(repository.list(1, 10).items[0]?.audioQuality?.status, 'passed')
    repository.updateAudioQuality('new', { status: 'rejected', reason: 'interference_tone', metrics: null })
    assert.equal(repository.find('new')?.recognition, 'ASR')
    assert.equal(repository.find('new')?.manualCallsign, 'BG5XXX')
    assert.equal(repository.updateAudioQuality('deleted', { status: 'passed', reason: null, metrics: null }), false)
  }
  finally { repository.close() }
})

test('reference searches keep historical skip vectors but exclude known rejected or failed checks', () => {
  const repository = new RecordRepository(':memory:')
  try {
    const embedding = new Float32Array(SPEAKER_DIMENSIONS)
    embedding[0] = 1
    for (const status of ['passed', 'skip', 'rejected', 'unknown'] as const) {
      repository.insert('1900', { id: status, timestamp: '2026-11-22T01:00:00Z', durationMs: 2000, voicedMs: 1500, recognition: 'ASR' })
      repository.updateManualReview(status, { reviewed: true, callsign: 'BG5XXX' })
      repository.saveQueryVoiceprint(status, { status: 'ready', version: SPEAKER_VERSION, embedding })
      repository.updateAudioQuality(status, { status, reason: null, metrics: null })
    }
    const result = repository.searchSpeakerMatches({ status: 'ready', version: SPEAKER_VERSION, embedding }, 'query')
    assert.equal(result.referenceCount, 2)
    assert.equal(result.matches[0]?.count, 2)
    assert.equal(repository.recentSpeakerReferences(['BG5XXX'], 'query')[0]?.embeddings.length, 2)
  }
  finally { repository.close() }
})
