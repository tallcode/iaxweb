import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { speakerRecognitionSchema } from '@iaxweb/contracts'
import { AudioQualityService } from '../../src/ai/audio-quality.js'
import { SPEAKER_DIMENSIONS, SPEAKER_VERSION } from '../../src/ai/speaker-model.mjs'
import { checkSpeakerQuality } from '../../src/ai/speaker-quality.mjs'
import { SpeakerReferenceService } from '../../src/ai/speaker-references.js'
import { speakerWavFile } from '../../src/ai/speaker-wav.js'
import { SpeakerExtractor } from '../../src/ai/speaker.js'
import { encodeWav } from '../../src/ai/wav.js'
import { RecordRepository } from '../../src/records/record-repository.js'
import { RecordingStore } from '../../src/records/recording-store.js'

function speechLikeAudio(): Int16Array {
  let state = 123
  let previous = 0
  let filtered = 0
  // Smooth broadband audio without the spectral notches of a boxcar filter;
  // this fixture must pass quality checks so the test reaches model loading.
  return Int16Array.from({ length: 16000 }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    const sample = state / 0x100000000 - 0.5
    previous += 0.1 * (sample - previous)
    filtered += 0.1 * (previous - filtered)
    return Math.round(filtered * 16384)
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
  const audio = speechLikeAudio()
  const quality = checkSpeakerQuality(Float32Array.from(audio, sample => sample / 32768))
  assert.equal(quality.accepted, true, JSON.stringify(quality))
  new RecordingStore(directory).save(record.id, record.timestamp, encodeWav(audio))
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

test('manual recognition sorts scores and caps confidence by the preceding match', async (t) => {
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
      { callsign: 'BG5EEE', count: 1, similarity: 0.82 },
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
  assert.deepEqual(result.matches.map(match => [match.callsign, match.confidence]), [
    ['BG5AAA', 'high'],
    ['BG5BBB', 'medium'],
    ['BG5DDD', 'medium'],
    ['BG5CCC', 'low'],
    ['BG5EEE', null],
  ])
})

test('ten-reference confidence boundaries and an unconfident predecessor constrain later matches', async (t) => {
  const repository = new RecordRepository(':memory:')
  const service = new SpeakerReferenceService({ repository, recordingsDirectory: 'unused', modelFile: 'unused' })
  t.after(() => {
    service.stop()
    repository.close()
  })
  repository.insert('1900', { id: 'query', timestamp: '2026-11-19T12:20:52Z', durationMs: 1000, voicedMs: 1000, recognition: '收到' })
  const embedding = new Float32Array(SPEAKER_DIMENSIONS)
  embedding[0] = 1
  repository.saveQueryVoiceprint('query', { status: 'ready', version: SPEAKER_VERSION, embedding })
  let matches: Array<{ callsign: string, count: number, minSimilarity: number, maxSimilarity: number, averageSimilarity: number }> = []
  t.mock.method(repository, 'searchSpeakerMatches', () => ({ referenceCount: 20, matches }))
  t.mock.method(repository, 'recentSpeakerReferences', () => [])
  for (const [count, similarity, expected] of [[10, 0.85, 'high'], [10, 0.8499, 'medium'], [9, 0.85, 'medium']] as const) {
    matches = [{ callsign: 'BG5AAA', count, minSimilarity: similarity, maxSimilarity: similarity, averageSimilarity: similarity }]
    assert.equal((await service.recognizeRecord('query')).matches[0]?.confidence, expected)
  }
  matches = [
    { callsign: 'BG5GXT', count: 10, minSimilarity: 0.81, maxSimilarity: 0.81, averageSimilarity: 0.81 },
    { callsign: 'BG5EBE', count: 3, minSimilarity: 0.88, maxSimilarity: 0.88, averageSimilarity: 0.88 },
    { callsign: 'BG5GYT', count: 3, minSimilarity: 0.84, maxSimilarity: 0.84, averageSimilarity: 0.84 },
  ]
  const result = await service.recognizeRecord('query')
  assert.deepEqual(result.matches.map(match => [match.callsign, match.confidence]), [
    ['BG5EBE', 'low'],
    ['BG5GYT', null],
    ['BG5GXT', null],
  ])
})

test('manual recognition keeps an existing voiceprint without reading or extracting audio again', async (t) => {
  const repository = new RecordRepository(':memory:')
  const service = new SpeakerReferenceService({ repository, recordingsDirectory: 'unused', modelFile: 'unused' })
  t.after(() => {
    service.stop()
    repository.close()
  })
  repository.insert('1900', { id: 'cached-query', timestamp: '2026-11-22T06:00:00Z', durationMs: 2000, voicedMs: 1500, recognition: '收到' })
  const embedding = new Float32Array(SPEAKER_DIMENSIONS)
  embedding[0] = 1
  const voiceprint = { status: 'ready', version: SPEAKER_VERSION, embedding } as const
  repository.saveQueryVoiceprint('cached-query', voiceprint)
  const extract = t.mock.method(SpeakerExtractor.prototype, 'extract', async () => {
    throw new Error('A stored voiceprint must be reused')
  })
  t.mock.method(repository, 'searchSpeakerMatches', () => ({ referenceCount: 0, matches: [] }))
  const result = await service.recognizeRecord('cached-query')
  assert.equal(result.status, 'no_match')
  assert.equal(result.measurements.audioReadMs, null)
  assert.equal(extract.mock.callCount(), 0)
  assert.deepEqual(repository.findReadyVoiceprint('cached-query'), voiceprint)
  assert.equal(repository.find('cached-query')?.reviewed, false)
})

test('prior quality rejections are retried only manually and a successful retry is cached', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'iaxweb-speaker-manual-retry-'))
  const repository = new RecordRepository(':memory:')
  const service = new SpeakerReferenceService({ repository, recordingsDirectory: directory, modelFile: 'unused' })
  t.after(() => {
    service.stop()
    repository.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const record = { id: 'aabbcc01', timestamp: '2026-11-22T06:00:00Z', durationMs: 2000, voicedMs: 1500, recognition: '收到' }
  repository.insert('1900', record)
  repository.updateManualReview(record.id, { reviewed: true, callsign: 'BG5XXX' })
  repository.updateVoiceprint(record.id, { status: 'unavailable', version: SPEAKER_VERSION, reason: 'interference_high_band' })
  new RecordingStore(directory).save(record.id, record.timestamp, encodeWav(speechLikeAudio()))
  const embedding = new Float32Array(SPEAKER_DIMENSIONS)
  embedding[0] = 1
  let attempts = 0
  t.mock.method(SpeakerExtractor.prototype, 'extract', async () => ++attempts === 1
    ? { status: 'unavailable', version: SPEAKER_VERSION, reason: 'interference_high_band' } as const
    : { status: 'ready', version: SPEAKER_VERSION, embedding } as const)
  t.mock.method(repository, 'searchSpeakerMatches', () => ({ referenceCount: 0, matches: [] }))

  await service.processPending()
  assert.equal(attempts, 0)
  assert.equal((await service.recognizeRecord(record.id)).reasonCode, 'interference_high_band')
  assert.equal(attempts, 1)
  await service.processPending()
  assert.equal(attempts, 1)
  assert.equal((await service.recognizeRecord(record.id)).status, 'no_match')
  assert.equal(attempts, 2)
  assert.equal((await service.recognizeRecord(record.id)).status, 'no_match')
  assert.equal(attempts, 2)
  assert.deepEqual(repository.findReadyVoiceprint(record.id), { status: 'ready', version: SPEAKER_VERSION, embedding })
  assert.deepEqual(repository.pendingReviewedVoiceprints(), [])
  assert.equal(repository.find(record.id)?.reviewed, true)
  assert.equal(repository.find(record.id)?.manualCallsign, 'BG5XXX')
})

test('historical skip and failed unknown quality can be retried manually, without background work', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'iaxweb-speaker-skip-'))
  const repository = new RecordRepository(':memory:')
  const service = new SpeakerReferenceService({ repository, recordingsDirectory: directory, modelFile: 'unused' })
  t.after(() => {
    service.stop()
    repository.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const record = { id: 'aabbcc02', timestamp: '2026-11-22T01:00:00Z', durationMs: 2000, voicedMs: 1500, recognition: '历史', audioQuality: { status: 'skip', reason: null, metrics: null } as const }
  repository.insert('1900', record)
  repository.updateManualReview(record.id, { reviewed: true, callsign: 'BG5XXX' })
  const old = new Float32Array(SPEAKER_DIMENSIONS)
  old[0] = 1
  repository.saveQueryVoiceprint(record.id, { status: 'ready', version: SPEAKER_VERSION, embedding: old })
  new RecordingStore(directory).save(record.id, record.timestamp, encodeWav(speechLikeAudio()))
  let checks = 0
  t.mock.method(AudioQualityService.prototype, 'check', async () => ++checks === 1
    ? { status: 'unknown', reason: 'check_timeout', metrics: null } as const
    : { status: 'passed', reason: null, metrics: null } as const)
  const fresh = new Float32Array(SPEAKER_DIMENSIONS)
  fresh[1] = 1
  const extract = t.mock.method(SpeakerExtractor.prototype, 'extract', async () => ({ status: 'ready', version: SPEAKER_VERSION, embedding: fresh } as const))
  t.mock.method(repository, 'searchSpeakerMatches', () => ({ referenceCount: 0, matches: [] }))
  await service.processPending()
  assert.equal(checks, 0)
  assert.equal((await service.recognizeRecord(record.id)).status, 'unavailable')
  assert.equal(extract.mock.callCount(), 0)
  assert.deepEqual(repository.findReadyVoiceprint(record.id)?.embedding, old)
  assert.equal(repository.find(record.id)?.audioQuality?.status, 'unknown')
  await service.processPending()
  assert.equal(checks, 1)
  assert.equal((await service.recognizeRecord(record.id)).status, 'no_match')
  assert.equal(extract.mock.callCount(), 1)
  assert.deepEqual(repository.findReadyVoiceprint(record.id)?.embedding, fresh)
  assert.equal((await service.recognizeRecord(record.id)).status, 'no_match')
  assert.equal(extract.mock.callCount(), 1)
})
