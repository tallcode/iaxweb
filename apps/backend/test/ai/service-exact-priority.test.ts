import type { RadioSignal, SpeakerMatch } from '@iaxweb/contracts'
import type { CallsignExtraction } from '../../src/ai/callsign-extraction.js'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { AUDIO_QUALITY_GATE_VERSION } from '@iaxweb/contracts'
import { AsrClient } from '../../src/ai/asr-client.js'
import { AudioQualityService } from '../../src/ai/audio-quality.js'
import { LlmParser } from '../../src/ai/llm-parser.js'
import { SegmentRecognition } from '../../src/ai/segment-recognition.js'
import { SegmentStore } from '../../src/ai/segment-store.js'
import { loadAiConfig } from '../../src/config.js'
import { RecordRepository } from '../../src/records/record-repository.js'
import { SignalingService } from '../../src/signaling/service.js'

const SELF = 'BG5BUD'
const CORRECTED = 'BG5BUT'
const nearSpelling = 'Bravo Golf Five Bravo Uniform Tango'
const exactSpelling = 'Bravo Golf Five Bravo Uniform Delta'
const feature: SpeakerMatch = {
  callsign: SELF,
  confidence: 'high',
  count: 10,
  minSimilarity: 0.9,
  maxSimilarity: 0.95,
  averageSimilarity: 0.92,
  referenceSimilarity: 0.93,
  referenceRecordCount: 10,
  trimmedReferenceSimilarity: 0.94,
  trimmedReferenceRecordCount: 8,
  referenceGroups: [],
}

function deferred() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

for (const source of ['feature', 'tail', 'empty', 'text'] as const) {
  test(`the production pipeline prioritizes exact ${source} evidence before text correction`, { timeout: 5000 }, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'iaxweb-exact-priority-'))
    const repository = new RecordRepository(':memory:')
    const support = deferred()
    const parsed = deferred()
    const words = source === 'text' ? exactSpelling : nearSpelling
    const expected = source === 'empty' ? CORRECTED : SELF
    let requests = 0
    let completed = false
    t.mock.method(AsrClient.prototype, 'transcribe', async () => `这里是 ${SELF}，${words}。`)
    t.mock.method(AudioQualityService.prototype, 'check', async () => ({ status: 'passed', reason: null, metrics: null, gateVersion: AUDIO_QUALITY_GATE_VERSION }))
    t.mock.method(SignalingService.prototype, 'decode', async (): Promise<readonly RadioSignal[]> => {
      if (source === 'tail' || source === 'text')
        await support.promise
      return source === 'tail' ? [{ type: 'BSS', content: SELF }] : []
    })
    t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
      requests++
      const body = JSON.parse(String(init?.body))
      const input = JSON.parse(body.messages[1].content)
      const extraction: CallsignExtraction = {
        selfCallsigns: [{ identityEvidence: '这里是', quote: SELF, type: 'compact', callsign: SELF, confidence: 'medium' }],
        spelledCallsigns: [{ sourceId: input.current.id, quote: words, correctedSpelling: words, callsign: expected === SELF && source === 'text' ? SELF : CORRECTED, confidence: 'high' }],
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(extraction) } }] }), { status: 200 })
    })
    const parse = LlmParser.prototype.parse
    t.mock.method(LlmParser.prototype, 'parse', async function (this: LlmParser, ...args: Parameters<LlmParser['parse']>) {
      const result = await parse.apply(this, args)
      parsed.resolve()
      return result
    })
    const config = loadAiConfig({
      AI_PERSISTENCE_ENABLED: 'true',
      AI_LLM_ENABLED: 'true',
      AI_LLM_STAGE2_ENABLED: 'true',
      AI_RECORDINGS_DIR: directory,
      AI_LLM_PROMPT_FILE: fileURLToPath(new URL('../../../../examples/ai/simple/prompt.txt', import.meta.url)),
      AI_LLM_SCHEMA_FILE: fileURLToPath(new URL('../../../../examples/ai/schema.json', import.meta.url)),
    })
    const recognition = new SegmentRecognition({
      config,
      repository,
      speakerReferences: {
        startLiveRecognition: () => ({
          voiceprint: Promise.resolve(undefined),
          matches: (async () => {
            if (source === 'feature' || source === 'text')
              await support.promise
            return source === 'feature' ? [feature] : []
          })(),
        }),
        cacheQueryVoiceprint() {},
      },
    })
    t.after(() => {
      recognition.stop()
      support.resolve()
      repository.close()
      rmSync(directory, { recursive: true, force: true })
    })
    const work = recognition.process('1900', new SegmentStore(config.contextWindowMs), {
      capturedAt: '2026-11-27T00:00:00.000Z',
      durationMs: 2000,
      voicedMs: 1500,
      payloads: [new Uint8Array(16_000).fill(255)],
    }).then(() => { completed = true })
    await parsed.promise
    await new Promise<void>(resolve => setImmediate(resolve))
    if (source === 'feature' || source === 'tail') {
      assert.equal(completed, false, 'a near text match must wait for pending exact evidence')
      assert.equal(repository.list(1, 10).items[0]?.callsign, null)
      support.resolve()
    }
    await work
    assert.equal(completed, true)
    assert.equal(requests, 1)
    assert.equal(repository.list(1, 10).items[0]?.callsign, expected)
    assert.equal(repository.list(1, 10).items[0]?.callsignAlgorithm, 'stage1_text')
  })
}
