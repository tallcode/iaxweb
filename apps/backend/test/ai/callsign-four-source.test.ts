import type { RadioSignal, SpeakerMatch } from '@iaxweb/contracts'
import type { CallsignExtraction } from '../../src/ai/callsign-extraction.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { prepareCallsignExtraction, resolveCallsign } from '../../src/ai/callsign-extraction.js'

const schema = JSON.parse(readFileSync(new URL('../../../../examples/ai/schema.json', import.meta.url), 'utf8')) as Record<string, unknown>
const A = 'BG5GZX'
const B = 'BG5GZY'
const C = 'BG5GZW'
const words = 'Bravo Golf Five Golf Zulu X-ray'
const otherWords = 'Bravo Golf Five Golf Zulu Yankee'
const current = { id: 'current', text: `这里是 ${A}，${words}。` }
const history = [{ id: 'previous', text: `${words}，${otherWords}。` }]
const compact = (callsign = A, confidence: 'medium' | 'low' = 'medium'): CallsignExtraction['selfCallsigns'][number] => ({ identityEvidence: '这里是', quote: callsign, type: 'compact', callsign, confidence })
const spelled = (callsign = A, confidence: 'high' | 'medium' | 'low' = 'high', sourceId = 'previous'): CallsignExtraction['spelledCallsigns'][number] => ({ sourceId, quote: callsign === B ? otherWords : words, correctedSpelling: callsign === B ? otherWords : words, callsign, confidence })
const feature = (callsign = A, confidence: 'high' | 'medium' | 'low' = 'high'): Pick<SpeakerMatch, 'callsign' | 'confidence'> => ({ callsign, confidence })
const tail = (content = A, type: RadioSignal['type'] = 'BSS'): RadioSignal => ({ content, type })
function resolve(extraction: CallsignExtraction, matches: readonly Pick<SpeakerMatch, 'callsign' | 'confidence'>[] = [], signals: readonly RadioSignal[] = [], turn = current) {
  const prepared = prepareCallsignExtraction(extraction, turn, history, schema)
  assert.ok(prepared)
  return resolveCallsign(prepared, matches, signals)
}

test('LLM self corroborated by a feature is still stage 1', () => {
  const result = resolve({ selfCallsigns: [compact()], spelledCallsigns: [] }, [feature(B, 'medium')])
  assert.equal(result.callsign, B)
  assert.equal(result.algorithm, 'stage1_text')
})

test('feature substitution for a truly missing self is stage 2', () => {
  const result = resolve({ selfCallsigns: [], spelledCallsigns: [] }, [feature()], [tail(`${A}-7/P`, 'APRS')])
  assert.equal(result.callsign, A)
  assert.equal(result.algorithm, 'stage2_feature')
})

test('unique complete high-confidence spelled self is stage 1 without another source', () => {
  const result = resolve({ selfCallsigns: [{ identityEvidence: '这里是', quote: words, type: 'spelling', callsign: A, confidence: 'high' }], spelledCallsigns: [spelled(A, 'high', 'current')] })
  assert.equal(result.callsign, A)
  assert.equal(result.algorithm, 'stage1_text')
})

test('an invalid existing self must not become a missing-self feature fallback', () => {
  const result = resolve({ selfCallsigns: [compact('BG5FGBR')], spelledCallsigns: [] }, [feature()], [tail()], { id: 'current', text: '这里是 BG5FGBR。' })
  assert.equal(result.callsign, undefined)
  assert.equal(result.algorithm, undefined)
})

test('unsupported identity provenance cannot be replaced by a feature', () => {
  const result = resolve({ selfCallsigns: [compact()], spelledCallsigns: [] }, [feature()], [tail()], { id: 'current', text: `${A}，请你再说一遍。` })
  assert.equal(result.callsign, undefined)
})

test('a medium spelled self cannot corroborate itself using the same character span', () => {
  const result = resolve({ selfCallsigns: [{ identityEvidence: '这里是', quote: words, type: 'spelling', callsign: A, confidence: 'medium' }], spelledCallsigns: [spelled(A, 'medium', 'current')] })
  assert.equal(result.callsign, undefined)
})

test('an independent historical spelling can corroborate medium spelled self', () => {
  const result = resolve({ selfCallsigns: [{ identityEvidence: '这里是', quote: words, type: 'spelling', callsign: A, confidence: 'medium' }], spelledCallsigns: [spelled(A, 'medium', 'current'), spelled(A, 'medium')] })
  assert.equal(result.callsign, A)
  assert.equal(result.algorithm, 'stage1_text')
})

test('same introduction compact and spelling views do not count as two self reports', () => {
  const result = resolve({ selfCallsigns: [compact(), { identityEvidence: '这里是', quote: words, type: 'spelling', callsign: A, confidence: 'medium' }], spelledCallsigns: [spelled(A, 'medium', 'current')] })
  assert.equal(result.callsign, A)
})

test('the highest feature tier is selected before distance matching', () => {
  const result = resolve({ selfCallsigns: [compact()], spelledCallsigns: [] }, [feature('BD6KOD'), feature(A, 'medium')])
  assert.equal(result.callsign, undefined)
})

test('an ambiguous spelling set can only be narrowed by later sources', () => {
  const raw = { selfCallsigns: [compact()], spelledCallsigns: [spelled(), spelled(B)] }
  assert.equal(resolve(raw, [feature(C)]).callsign, undefined)
  assert.equal(resolve(raw, [feature(B)]).callsign, B)
})

test('unique spelling corroboration takes priority over feature and tail', () => {
  const result = resolve({ selfCallsigns: [compact()], spelledCallsigns: [spelled()] }, [feature(B)], [tail(C)])
  assert.equal(result.callsign, A)
})

test('multiple self calls are downgraded only once and require exact high evidence', () => {
  const raw = { selfCallsigns: [compact(), compact(B)], spelledCallsigns: [spelled()] }
  const turn = { id: 'current', text: `这里是 ${A}，这里是 ${B}。` }
  assert.equal(resolve(raw, [], [], turn).callsign, A)
  assert.equal(resolve({ ...raw, spelledCallsigns: [spelled(A, 'medium')] }, [], [], turn).callsign, undefined)
})

test('tail candidates reject unknown protocols and malformed suffixes', () => {
  const raw = { selfCallsigns: [compact()], spelledCallsigns: [] }
  assert.equal(resolve(raw, [], [tail(A, 'DTMF')]).callsign, undefined)
  assert.equal(resolve(raw, [], [tail(`${A}-16`, 'APRS')]).callsign, undefined)
  assert.equal(resolve(raw, [], [tail(`${A}/P/P`)]).callsign, undefined)
  assert.equal(resolve(raw, [], [tail(`${A}/P-7`, 'APRS')]).callsign, A)
})

test('standard spelling character derivation never changes compact self letters or grades', () => {
  const raw: CallsignExtraction = { selfCallsigns: [compact(B)], spelledCallsigns: [{ ...spelled(), callsign: B }] }
  const before = structuredClone(raw)
  const prepared = prepareCallsignExtraction(raw, { id: 'current', text: `这里是 ${B}。` }, history, schema)
  assert.ok(prepared)
  assert.equal(prepared.extraction.selfCallsigns[0]?.callsign, B)
  assert.equal(prepared.extraction.selfCallsigns[0]?.confidence, 'medium')
  assert.equal(prepared.extraction.spelledCallsigns[0]?.callsign, A)
  assert.deepEqual(raw, before)
})

test('a malformed complete spelling is discarded individually without losing a valid current self', () => {
  const raw: CallsignExtraction = { selfCallsigns: [compact()], spelledCallsigns: [{ ...spelled(), callsign: 'BG5FGBR', correctedSpelling: '' }] }
  const result = resolve(raw, [feature()])
  assert.equal(result.callsign, A)
  assert.equal(result.algorithm, 'stage1_text')
})
