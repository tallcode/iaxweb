import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { SPEAKER_DIMENSIONS, SPEAKER_VERSION } from '../../src/ai/speaker-model.mjs'
import { RecordRepository } from '../../src/records/record-repository.js'

test('historical quality migrates to skip once without changing stored vectors or analysis', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'iaxweb-audio-quality-migration-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = join(directory, 'history.sqlite')
  const before = new RecordRepository(file)
  const embedding = new Float32Array(SPEAKER_DIMENSIONS)
  embedding[0] = 1
  for (const id of ['ready', 'rejected', 'resource', 'plain']) {
    before.insert('1900', { id, timestamp: '2026-11-22T01:00:00Z', durationMs: 2000, voicedMs: 1500, recognition: 'original' })
    before.updateManualReview(id, { reviewed: true, callsign: 'BG5XXX', recognition: 'manual' })
  }
  before.updateVoiceprint('ready', { status: 'ready', version: SPEAKER_VERSION, embedding })
  before.updateVoiceprint('resource', { status: 'unavailable', version: SPEAKER_VERSION, reason: 'resource_limit_2g' })
  before.close()
  const raw = new DatabaseSync(file)
  raw.exec('ALTER TABLE ai_segments DROP COLUMN audio_quality')
  raw.prepare('UPDATE ai_segment_embeddings SET status = ?, reason = ? WHERE record_id = ?').run('unavailable', 'interference_high_band', 'rejected')
  const vectorBefore = raw.prepare('SELECT embedding FROM ai_segment_embeddings WHERE record_id = ?').get('ready')?.embedding
  const repository = new RecordRepository(file)
  for (const id of ['ready', 'rejected', 'resource', 'plain']) {
    const row = repository.find(id)!
    assert.equal(row.audioQuality?.status, 'skip')
    assert.equal(row.audioQuality?.metrics, null)
    assert.equal(row.recognition, 'original')
    assert.equal(row.manualRecognition, 'manual')
    assert.equal(row.manualCallsign, 'BG5XXX')
  }
  assert.equal(repository.find('rejected')?.audioQuality?.reason, 'interference_high_band')
  assert.equal(raw.prepare('SELECT reason FROM ai_segment_embeddings WHERE record_id = ?').get('rejected')?.reason, null)
  assert.equal(raw.prepare('SELECT reason FROM ai_segment_embeddings WHERE record_id = ?').get('resource')?.reason, 'resource_limit_2g')
  assert.deepEqual(raw.prepare('SELECT embedding FROM ai_segment_embeddings WHERE record_id = ?').get('ready')?.embedding, vectorBefore)
  assert.deepEqual(repository.pendingReviewedVoiceprints(), [])
  repository.updateAudioQuality('plain', { status: 'unknown', reason: 'check_timeout', metrics: null })
  repository.close()
  const reopened = new RecordRepository(file)
  assert.equal(reopened.find('plain')?.audioQuality?.status, 'unknown')
  assert.equal(reopened.find('ready')?.audioQuality?.status, 'skip')
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
