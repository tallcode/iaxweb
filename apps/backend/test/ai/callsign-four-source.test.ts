import type { RadioSignal, SpeakerMatch } from '@iaxweb/contracts'
import type { CallsignExtraction } from '../../src/ai/callsign-extraction.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { prepareCallsignExtraction, resolveCallsign } from '../../src/ai/callsign-extraction.js'
import { decide } from '../../src/ai/callsign-policy.js'

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

test('a feature may correct a medium compact self and returns the reference callsign', () => {
  const raw = { selfCallsigns: [compact()], spelledCallsigns: [] }
  const corrected = resolve(raw, [feature(B, 'medium')])
  assert.equal(corrected.callsign, B)
  assert.notEqual(corrected.callsign, A)
  assert.equal(corrected.algorithm, 'stage1_text')
  const result = resolve(raw, [feature(A, 'medium')])
  assert.equal(result.callsign, A)
  assert.equal(result.algorithm, 'stage1_text')
})

test('feature substitution for a truly missing self is stage 2', () => {
  const result = resolve({ selfCallsigns: [], spelledCallsigns: [] }, [feature()], [tail(`${A}-7/P`, 'APRS')])
  assert.equal(result.callsign, A)
  assert.equal(result.algorithm, 'stage2_feature')
})

test('a feature substitute requires an exact match with spelling or tail', () => {
  const raw = { selfCallsigns: [], spelledCallsigns: [spelled(B)] }
  assert.equal(resolve(raw, [feature()]).callsign, undefined)
  assert.equal(resolve({ ...raw, spelledCallsigns: [] }, [feature()], [tail(B)]).callsign, undefined)
  assert.equal(resolve(raw, [feature(B)]).callsign, B)
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

test('a medium spelled self requires exact spelling, feature or tail corroboration', () => {
  const raw: CallsignExtraction = {
    selfCallsigns: [{ identityEvidence: '这里是', quote: words, type: 'spelling', callsign: A, confidence: 'medium' }],
    spelledCallsigns: [spelled(A, 'medium', 'current')],
  }
  assert.equal(resolve({ ...raw, spelledCallsigns: [...raw.spelledCallsigns, spelled(B)] }).callsign, undefined)
  assert.equal(resolve(raw, [feature(B)]).callsign, undefined)
  assert.equal(resolve(raw, [feature()]).callsign, A)
  assert.equal(resolve(raw, [], [tail(B)]).callsign, undefined)
  assert.equal(resolve(raw, [], [tail()]).callsign, A)
})

test('a tied spelled self cannot borrow the compact self distance allowance', () => {
  const result = decide({
    eligible: true,
    hadSelf: true,
    selves: [
      { callsign: A, confidence: 'medium', kind: 'compact', spans: [{ sourceId: 'current', start: 10, end: 16 }] },
      { callsign: A, confidence: 'medium', kind: 'spelling', spans: [{ sourceId: 'current', start: 30, end: 60 }] },
    ],
    // The independent self evidence is a spelling, since the compact span overlaps the reference.
    spellings: [{ callsign: B, confidence: 'high', kind: 'spelling', spans: [{ sourceId: 'current', start: 12, end: 24 }] }],
    features: [],
    signals: [],
  })
  assert.equal(result.callsign, null)
})

test('same introduction compact and spelling views do not count as two self reports', () => {
  const result = resolve({ selfCallsigns: [compact(), { identityEvidence: '这里是', quote: words, type: 'spelling', callsign: A, confidence: 'medium' }], spelledCallsigns: [spelled(A, 'medium', 'current')] })
  assert.equal(result.callsign, A)
})

test('the highest feature tier is selected before distance matching', () => {
  const result = resolve({ selfCallsigns: [compact()], spelledCallsigns: [] }, [feature('BD6KOD'), feature(A, 'medium')])
  assert.equal(result.callsign, undefined)
})

test('an exact spelling match wins over a near match from the same source', () => {
  const raw = { selfCallsigns: [compact()], spelledCallsigns: [spelled(), spelled(B)] }
  assert.equal(resolve(raw, [feature(C)]).callsign, A)
  assert.equal(resolve(raw, [feature(B)]).callsign, A)
  assert.equal(resolve(raw, [feature(A)]).callsign, A)
  assert.equal(resolve(raw, [], [tail(B)]).callsign, A)
})

test('an ambiguous exact spelling set can only be narrowed within both candidate sets', () => {
  const raw = { selfCallsigns: [compact(), compact(B)], spelledCallsigns: [spelled(), spelled(B)] }
  const turn = { id: 'current', text: `这里是 ${A}，这里是 ${B}。` }
  assert.equal(resolve(raw, [feature(C)], [], turn).callsign, undefined)
  assert.equal(resolve(raw, [feature(B)], [], turn).callsign, B)
  assert.equal(resolve(raw, [feature(A)], [], turn).callsign, A)
})

test('an exact feature takes priority over near spelling corroboration', () => {
  const result = resolve({ selfCallsigns: [compact()], spelledCallsigns: [spelled(B)] }, [feature(A)], [tail(C)])
  assert.equal(result.callsign, A)
  assert.equal(result.decision.steps.at(-1)?.source, 'feature')
  assert.equal(result.decision.steps.every(step => step.maxDistance === 0), true)
})

test('an exact tail takes priority over near spelling and feature corroboration', () => {
  const result = resolve({ selfCallsigns: [compact()], spelledCallsigns: [spelled(B)] }, [feature(C)], [tail(A)])
  assert.equal(result.callsign, A)
  assert.equal(result.decision.steps.at(-1)?.source, 'tail')
  assert.equal(result.decision.steps.every(step => step.maxDistance === 0), true)
})

test('medium spelling still confirms an exact compact self before other sources', () => {
  const result = resolve({ selfCallsigns: [compact()], spelledCallsigns: [spelled(A, 'medium')] }, [feature(B)], [tail(C)])
  assert.equal(result.callsign, A)
  assert.equal(result.algorithm, 'stage1_text')
  assert.equal(result.decision.steps.at(-1)?.source, 'spelling')
  assert.equal(result.decision.steps.every(step => step.maxDistance === 0), true)
})

test('only high historical spelling may remove W from a literal GWL self', () => {
  const turn = { id: 'current', text: 'CQ, CQ, CQ. This is BG5GWL, BG5GWL. We are local 555 with giving mark. Can you hear me? Over.' }
  const previous = { id: 'previous', text: 'CQ, CQ, CQ. This is BG5GWL, BG5GWL. Bravo Golf 5 Golf with Lima. Calling CQ, over.' }
  for (const confidence of ['medium', 'high'] as const) {
    const raw: CallsignExtraction = {
      selfCallsigns: [{ identityEvidence: 'This is', quote: 'BG5GWL', type: 'compact', callsign: 'BG5GWL', confidence: 'medium' }],
      spelledCallsigns: [{ sourceId: previous.id, quote: 'Bravo Golf 5 Golf with Lima', correctedSpelling: 'Bravo Golf Five Golf Lima', callsign: 'BG5GL', confidence }],
    }
    const prepared = prepareCallsignExtraction(raw, turn, [previous], schema)
    assert.ok(prepared)
    // This candidate survives character/source validation. Its confidence,
    // rather than a missing quote or malformed format, controls correction.
    assert.equal(prepared.input.spellings.length, 1)
    assert.equal(prepared.input.spellings[0]?.callsign, 'BG5GL')
    assert.equal(prepared.input.spellings[0]?.confidence, confidence)
    const result = resolveCallsign(prepared)
    assert.equal(result.callsign, confidence === 'high' ? 'BG5GL' : undefined)
    assert.equal(result.algorithm, confidence === 'high' ? 'stage1_text' : undefined)
    const correction = result.decision.steps.find(step => step.source === 'spelling' && step.maxDistance === 1)
    assert.ok(correction)
    assert.equal(correction.comparisons[0]?.distance, 1)
    assert.deepEqual(correction.matched, confidence === 'high' ? ['BG5GL'] : [])
  }
})

test('medium near spelling does not block one-character feature or tail correction', () => {
  const raw = { selfCallsigns: [compact()], spelledCallsigns: [spelled(B, 'medium')] }
  for (const support of [
    { matches: [feature(C, 'medium')], signals: [], source: 'feature' },
    { matches: [], signals: [tail(C)], source: 'tail' },
  ] as const) {
    const result = resolve(raw, support.matches, support.signals)
    assert.equal(result.callsign, C)
    assert.equal(result.algorithm, 'stage1_text')
    assert.equal(result.decision.steps.at(-1)?.source, support.source)
    assert.equal(result.decision.steps.at(-1)?.maxDistance, 1)
    assert.deepEqual(result.decision.steps.find(step => step.source === 'spelling' && step.maxDistance === 1)?.matched, [])
  }
})

test('a missing self can still use a high feature with exact medium spelling in stage 2', () => {
  const raw = { selfCallsigns: [], spelledCallsigns: [spelled(A, 'medium')] }
  const turn = { id: 'current', text: `${A}，收到您的信号。` }
  const result = resolve(raw, [feature(A)], [], turn)
  assert.equal(result.callsign, A)
  assert.equal(result.algorithm, 'stage2_feature')
  assert.equal(result.decision.steps.at(-1)?.source, 'spelling')
  assert.equal(result.decision.steps.every(step => step.maxDistance === 0), true)
  assert.equal(resolve(raw, [feature(B)], [], turn).callsign, undefined)
})

test('correction retains source priority after every exact source has failed', () => {
  const raw = { selfCallsigns: [compact()], spelledCallsigns: [spelled(B)] }
  const result = resolve(raw, [feature(C)], [tail(C)])
  assert.equal(result.callsign, B)
  assert.deepEqual(result.decision.steps.slice(0, 3).map(step => [step.source, step.maxDistance]), [['spelling', 0], ['feature', 0], ['tail', 0]])
  assert.equal(result.decision.steps.at(-1)?.maxDistance, 1)
  assert.equal(resolve({ ...raw, spelledCallsigns: [] }, [feature(C)], [tail(B)]).callsign, C)
})

test('exact-only resolution leaves compact correction pending until other sources arrive', () => {
  const raw = { selfCallsigns: [compact()], spelledCallsigns: [spelled(B)] }
  const prepared = prepareCallsignExtraction(raw, current, history, schema)
  assert.ok(prepared)
  const partial = resolveCallsign(prepared, [], [], { allowCompactCorrection: false })
  assert.equal(partial.callsign, undefined)
  assert.equal(partial.decision.steps.every(step => step.maxDistance === 0), true)
  assert.equal(resolveCallsign(prepared).callsign, B)
  assert.equal(resolveCallsign(prepared, [feature(A)]).callsign, A)
})

test('low compact self and a downgraded abbreviation never receive one-character correction', () => {
  const low = { selfCallsigns: [compact(A, 'low')], spelledCallsigns: [] }
  assert.equal(resolve(low, [feature(B)]).callsign, undefined)
  assert.equal(resolve(low, [feature(A)]).callsign, A)
  const short = { selfCallsigns: [compact('GZX')], spelledCallsigns: [] }
  const turn = { id: 'current', text: '这里是 GZX，B。' }
  assert.equal(resolve(short, [feature(B)], [], turn).callsign, undefined)
  assert.equal(resolve(short, [feature(A)], [], turn).callsign, A)
})

test('two-character compact errors remain unsupported', () => {
  const raw = { selfCallsigns: [compact('BG5SU')], spelledCallsigns: [] }
  const turn = { id: 'current', text: '这里是 BG5SU。' }
  assert.equal(resolve(raw, [feature('BG5HCU')], [tail('BG5HCU')], turn).callsign, undefined)
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
