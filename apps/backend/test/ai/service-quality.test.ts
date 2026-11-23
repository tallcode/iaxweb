import type { AudioQuality } from '@iaxweb/contracts'
import type { TranscriptTurn } from '../../src/ai/callsign-evidence.js'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AsrClient } from '../../src/ai/asr-client.js'
import { AudioQualityService } from '../../src/ai/audio-quality.js'
import { LlmParser } from '../../src/ai/llm-parser.js'
import { SegmentRecognition } from '../../src/ai/segment-recognition.js'
import { SegmentStore } from '../../src/ai/segment-store.js'
import { loadAiConfig } from '../../src/config.js'
import { RecordRepository } from '../../src/records/record-repository.js'

test('ASR and history survive rejected/unknown quality while only passed audio starts LLM and features', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'iaxweb-service-quality-'))
  const repository = new RecordRepository(':memory:')
  const texts = ['BG5XXX，第一条', 'BG5XXX，第二条', '这里是 BG5ABC']
  const qualities: AudioQuality[] = [
    { status: 'rejected', reason: 'interference_high_band', metrics: null },
    { status: 'unknown', reason: 'check_timeout', metrics: null },
    { status: 'passed', reason: null, metrics: null },
  ]
  let asrCalls = 0
  let qualityCalls = 0
  let featureCalls = 0
  let spots = 0
  let historySeen: readonly TranscriptTurn[] = []
  t.mock.method(AsrClient.prototype, 'transcribe', async () => texts[asrCalls++]!)
  t.mock.method(AudioQualityService.prototype, 'check', async () => {
    assert.equal(asrCalls, qualityCalls + 1)
    return qualities[qualityCalls++]!
  })
  const llm = t.mock.method(LlmParser.prototype, 'parse', async (_text: string, history?: string | readonly TranscriptTurn[]) => {
    historySeen = Array.isArray(history) ? history : []
    return { callsign: 'BG5ABC' }
  })
  const config = loadAiConfig({ AI_PERSISTENCE_ENABLED: 'true', AI_LLM_ENABLED: 'true', AI_LLM_STAGE2_ENABLED: 'true', AI_RECORDINGS_DIR: directory })
  const recognition = new SegmentRecognition({
    config,
    onSpot: () => { spots++ },
    repository: { insert: repository.insert.bind(repository), updateAutomaticCallsign: repository.updateAutomaticCallsign.bind(repository), find: repository.find.bind(repository) },
    speakerReferences: {
      startLiveRecognition: () => {
        featureCalls++
        return { voiceprint: Promise.resolve(undefined), matches: Promise.resolve([]) }
      },
      cacheQueryVoiceprint() {},
    },
  })
  t.after(() => {
    recognition.stop()
    repository.close()
    rmSync(directory, { recursive: true, force: true })
  })
  // Exercise the complete closed-segment pipeline without a network service
  // or dependence on segmentation timing. Recognition/quality are mocked here;
  // waveform quality behavior has its own recording replay and unit coverage.
  const store = new SegmentStore(config.contextWindowMs)
  const segment = { capturedAt: '2026-11-22T01:00:00.000Z', durationMs: 2000, voicedMs: 1500, payloads: [new Uint8Array(16_000).fill(255)] }
  for (let index = 0; index < 3; index++) {
    await recognition.process('1900', store, segment)
    assert.equal(llm.mock.callCount(), index < 2 ? 0 : 1)
    assert.equal(featureCalls, index < 2 ? 0 : 1)
  }
  assert.equal(asrCalls, 3)
  assert.equal(qualityCalls, 3)
  assert.equal(spots, 1)
  assert.deepEqual(historySeen.map(turn => turn.text), texts.slice(0, 2))
  const stored = repository.list(1, 10).items
  assert.equal(stored.length, 3)
  for (const record of stored) {
    const index = texts.indexOf(record.recognition)
    assert.equal(record.capturedAt, segment.capturedAt)
    assert.deepEqual(record.audioQuality, qualities[index])
    assert.equal(record.callsign, index === 2 ? 'BG5ABC' : null)
    assert.equal(record.callsignAlgorithm, index === 2 ? 'stage1_text' : null)
  }
})
