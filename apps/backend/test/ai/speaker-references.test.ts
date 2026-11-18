import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { speakerRecognitionSchema } from '@iaxweb/contracts'
import { SPEAKER_DIMENSIONS, SPEAKER_VERSION } from '../../src/ai/speaker-model.mjs'
import { SpeakerReferenceService } from '../../src/ai/speaker-references.js'
import { speakerWavFile } from '../../src/ai/speaker-wav.js'
import { SpeakerExtractor } from '../../src/ai/speaker.js'
import { encodeWav } from '../../src/ai/wav.js'
import { RecordRepository } from '../../src/records/record-repository.js'
import { RecordingStore } from '../../src/records/recording-store.js'

function speechLikeAudio(): Int16Array {
  let state = 123
  const noise = Float32Array.from({ length: 16031 }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000 - 0.5
  })
  return Int16Array.from({ length: 16000 }, (_, i) => {
    let sum = 0
    for (let j = 0; j < 32; j++) sum += noise[i + j]!
    return Math.round(sum / 32 * 16384)
  })
}

test('missing model leaves reviewed jobs pending for recovery', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'iaxweb-speaker-retry-'))
  const repository = new RecordRepository(':memory:')
  const service = new SpeakerReferenceService({ repository, recordingsDirectory: directory, modelFile: join(directory, 'missing.onnx') })
  t.after(() => {
    service.stop()
    repository.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const record = { id: 'aabb', timestamp: '2026-11-17T09:00:00Z', durationMs: 2000, voicedMs: 1500, recognition: '测试录音' }
  repository.insert('1900', record)
  repository.updateManualReview(record.id, { reviewed: true, callsign: 'BG5XXX' })
  new RecordingStore(directory).save(record.id, record.timestamp, encodeWav(speechLikeAudio()))
  await service.processPending()
  assert.deepEqual(repository.pendingReviewedVoiceprints(), [{ id: record.id, timestamp: record.timestamp, voicedMs: record.voicedMs }])
  await service.processPending()
  assert.equal(repository.pendingReviewedVoiceprints().length, 1)
})

test('invalid recordings are terminal failures and do not block later annotations', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'iaxweb-speaker-invalid-'))
  const repository = new RecordRepository(':memory:')
  const service = new SpeakerReferenceService({ repository, recordingsDirectory: directory, modelFile: join(directory, 'missing.onnx') })
  t.after(() => {
    service.stop()
    repository.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const record = { id: 'aacc', timestamp: '2026-11-17T09:00:00Z', durationMs: 2000, voicedMs: 1500, recognition: '损坏录音' }
  const later = { ...record, id: 'aadd' }
  repository.insert('1900', record)
  repository.insert('1900', later)
  repository.updateManualReview(record.id, { reviewed: true, callsign: 'BG5XXX' })
  repository.updateManualReview(later.id, { reviewed: true, callsign: 'BG5XXX' })
  new RecordingStore(directory).save(record.id, record.timestamp, encodeWav(new Int16Array(16000)))
  writeFileSync(speakerWavFile(directory, record), 'invalid WAV')
  await service.processPending()
  await service.processPending()
  assert.deepEqual(repository.pendingReviewedVoiceprints(), [])
})

test('manual recognition includes measurements on early recording failures without saving a voiceprint', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'iaxweb-speaker-measurements-'))
  const databaseFile = join(directory, 'records.sqlite')
  const repository = new RecordRepository(databaseFile)
  const service = new SpeakerReferenceService({ repository, recordingsDirectory: directory, modelFile: join(directory, 'missing.onnx') })
  t.after(() => {
    service.stop()
    repository.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const missing = speakerRecognitionSchema.parse(await service.recognizeRecord('aabb'))
  assert.equal(missing.reasonCode, 'record_missing')
  assert.equal(typeof missing.measurements.recordLookupMs, 'number')
  assert.equal(missing.measurements.audioReadMs, null)
  const record = { id: 'aabb', timestamp: '2026-11-17T09:00:00Z', durationMs: 2000, voicedMs: 1500, recognition: '测试录音' }
  repository.insert('1900', record)
  const result = speakerRecognitionSchema.parse(await service.recognizeRecord(record.id))
  assert.equal(result.reasonCode, 'recording_missing')
  assert.equal(typeof result.measurements.audioReadMs, 'number')
  assert.equal(result.measurements.queueWaitMs, null)
  assert.equal(result.measurements.databaseSearchMs, null)
  assert.equal(repository.find(record.id)?.recognition, record.recognition)
  const inspect = new DatabaseSync(databaseFile, { readOnly: true })
  try {
    assert.equal(inspect.prepare('SELECT COUNT(*) AS count FROM ai_segment_embeddings').get()?.count, 0)
  }
  finally { inspect.close() }
})

test('manual recognition returns the highest confidence across all scores with at least two references', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'iaxweb-speaker-confidence-'))
  const repository = new RecordRepository(':memory:')
  const service = new SpeakerReferenceService({ repository, recordingsDirectory: directory, modelFile: join(directory, 'missing.onnx') })
  t.after(() => {
    service.stop()
    repository.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const record = { id: 'aabb', timestamp: '2026-11-17T09:00:00Z', durationMs: 2000, voicedMs: 1500, recognition: '测试录音' }
  repository.insert('1900', record)
  new RecordingStore(directory).save(record.id, record.timestamp, encodeWav(speechLikeAudio()))
  const embedding = new Float32Array(SPEAKER_DIMENSIONS)
  embedding[0] = 1
  t.mock.method(SpeakerExtractor.prototype, 'extract', async () => ({ status: 'ready', version: SPEAKER_VERSION, embedding } as const))
  t.mock.method(repository, 'searchSpeakerMatches', () => ({
    referenceCount: 20,
    matches: [
      { callsign: 'BG5AAA', count: 5, similarity: 0.90 },
      { callsign: 'BG5BBB', count: 4, similarity: 0.90 },
      { callsign: 'BG5CCC', count: 5, similarity: 0.84 },
      { callsign: 'BG5DDD', count: 5, similarity: 0.86 },
      { callsign: 'BG5EEE', count: 1, similarity: 0.98 },
    ].map(({ callsign, count, similarity }) => ({ callsign, count, minSimilarity: similarity, maxSimilarity: similarity, averageSimilarity: similarity })),
  }))
  t.mock.method(repository, 'recentSpeakerReferences', () => [{ callsign: 'BG5DDD', embeddings: Array.from<Float32Array>({ length: 8 }).fill(embedding) }])
  t.mock.method(SpeakerExtractor.prototype, 'scoreReferences', async () => [{
    callsign: 'BG5DDD',
    referenceSimilarity: 0.77,
    referenceRecordCount: 8,
    trimmedReferenceSimilarity: 0.81,
    trimmedReferenceRecordCount: 7,
    referenceGroups: [{ similarity: 0.90, recordCount: 5 }],
  }])

  const result = speakerRecognitionSchema.parse(await service.recognizeRecord(record.id))
  assert.deepEqual(result.matches.map(match => match.confidence), ['high', 'medium', 'low', 'high', null])
})
