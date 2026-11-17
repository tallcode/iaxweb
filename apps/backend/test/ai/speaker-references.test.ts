import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SpeakerReferenceService } from '../../src/ai/speaker-references.js'
import { speakerWavFile } from '../../src/ai/speaker-wav.js'
import { encodeWav } from '../../src/ai/wav.js'
import { RecordRepository } from '../../src/records/record-repository.js'
import { RecordingStore } from '../../src/records/recording-store.js'

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
  repository.updateManualReview(record.id, { reviewed: true })
  new RecordingStore(directory).save(record.id, record.timestamp, encodeWav(new Int16Array(16000)))
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
  repository.updateManualReview(record.id, { reviewed: true })
  repository.updateManualReview(later.id, { reviewed: true })
  new RecordingStore(directory).save(record.id, record.timestamp, encodeWav(new Int16Array(16000)))
  writeFileSync(speakerWavFile(directory, record), 'invalid WAV')
  await service.processPending()
  assert.deepEqual(repository.pendingReviewedVoiceprints(), [])
})
