import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCallsignContext, extractCallsignEvidence } from '../../src/ai/callsign-evidence.js'
import { checkCallsignDecision, supportedSelfEvidence } from '../../src/ai/callsign-speaker.js'

function context(text: string) {
  return buildCallsignContext({ id: 'current', text })
}

test('compact callsigns and directly spoken letters do not create spelling evidence', () => {
  for (const text of ['这里是 BG5ATV', '这里是 B G 五 A T V', '这里是 BD1ESL'])
    assert.deepEqual(context(text).candidates, [])
})

test('keeps full explanation words and original offsets, including X Ray', () => {
  const text = '这里是 Bravo Golf Five Golf X Ray Delta'
  const evidence = context(text).candidates
  assert.deepEqual(evidence.map(item => item.callsign), ['BG5GXD'])
  assert.equal(text.slice(evidence[0]!.start, evidence[0]!.end), evidence[0]?.quote)
})

test('matches contiguous Chinese explanation words using the existing vocabulary', () => {
  assert.deepEqual(context('这里是补拉窝高尔夫五阿尔法探戈维克托').candidates.map(item => item.callsign), ['BG5ATV'])
})

test('accepts a complete suffix next to its prefix without borrowing a third-party suffix', () => {
  assert.deepEqual(context('这里是 BG5TOX，尾号 Tango Oscar X Ray').candidates.map(item => item.callsign), ['BG5TOX'])
  assert.deepEqual(context('这里是 BG5ABC。我抄到对方尾号 Delta Echo Foxtrot').candidates, [])
})

test('does not truncate complete three-letter suffixes or collapse repeated suffix letters', () => {
  assert.deepEqual(context('Bravo Golf Five Alpha Bravo Charlie').candidates.map(item => item.callsign), ['BG5ABC'])
  assert.deepEqual(context('Bravo Golf Five Golf Golf Golf').candidates.map(item => item.callsign), ['BG5GGG'])
})

test('only completes spelling across adjacent chunks of the same transmission', () => {
  const previous = { id: 'first', text: '这里是 Bravo Golf Five', transmissionId: 'a', partIndex: 0 }
  const current = { id: 'second', text: 'Alpha Tango Victor', transmissionId: 'a', partIndex: 1 }
  const yes = buildCallsignContext(current, [previous])
  assert.equal(yes.candidates[0]?.callsign, 'BG5ATV')
  assert.deepEqual(yes.candidates[0]?.segmentIds, ['first', 'second'])
  for (const other of [{ ...current, transmissionId: 'b' }, { ...current, partIndex: 2 }, { id: 'second', text: current.text }])
    assert.deepEqual(buildCallsignContext(other, [previous]).candidates, [])
})

test('rejects a callee even if a model supplies its real explanation evidence', () => {
  const text = 'Bravo Golf Five Alpha Tango Victor，这里是 BG5TOX'
  const c = context(text)
  assert.equal(checkCallsignDecision({ speaker: 'self', quote: text, callsign: 'BG5ATV', evidence: 1 }, c).callsign, undefined)
  assert.deepEqual(supportedSelfEvidence(c), [])
})

test('rejects copied confirmation and ungrounded ownership quotes', () => {
  for (const text of ['我抄收您的呼号是 Bravo Golf Five Alpha Tango Victor，是否正确？', '好的好的，Bravo Golf Five Alpha Tango Victor，我现在QTH在杭州']) {
    const c = context(text)
    assert.equal(checkCallsignDecision({ speaker: 'self', quote: text, callsign: 'BG5ATV', evidence: 1 }, c).callsign, undefined)
    assert.deepEqual(supportedSelfEvidence(c), [])
  }
})

test('historical spelling requires the same current explicitly self-reported callsign', () => {
  const history = [{ id: 'prior', text: 'Bravo Golf Five Alpha Tango Victor，我抄收是否正确' }]
  const yes = buildCallsignContext({ id: 'current', text: '这里是 BG5ATV' }, history)
  assert.equal(checkCallsignDecision({ speaker: 'self', quote: '这里是 BG5ATV', callsign: 'BG5ATV', evidence: 1 }, yes).callsign, 'BG5ATV')
  const no = buildCallsignContext({ id: 'current', text: '这里是 BD1ESL' }, history)
  assert.deepEqual(supportedSelfEvidence(no), [])
  const tooLong = buildCallsignContext({ id: 'current', text: '这里是 BG5ATVX' }, history)
  assert.equal(checkCallsignDecision({ speaker: 'self', quote: '这里是 BG5ATV', callsign: 'BG5ATV', evidence: 1 }, tooLong).callsign, undefined)
  assert.deepEqual(supportedSelfEvidence(tooLong), [])
  for (const text of ['BG5ATV，这里是 BG5TOX', '我听到他说“这里是 BG5ATV”', '这里是 BG5TOX，你呼号是 BG5ATV 吗？']) {
    const other = buildCallsignContext({ id: 'current', text }, history)
    assert.equal(checkCallsignDecision({ speaker: 'self', quote: text, callsign: 'BG5ATV', evidence: 1 }, other).callsign, undefined)
    assert.deepEqual(supportedSelfEvidence(other), [])
  }
})

test('a third-party quoted self-introduction is not current ownership evidence', () => {
  const quote = '这里是 Bravo Golf Five Alpha Tango Victor'
  const c = context(`我听到他说“${quote}”`)
  assert.equal(checkCallsignDecision({ speaker: 'self', quote, callsign: 'BG5ATV', evidence: 1 }, c).error, 'reported-self-introduction')
  assert.deepEqual(supportedSelfEvidence(c), [])
})

test('does not salvage a missing third suffix letter as a shorter legal callsign', () => {
  const text = '这里是 BH5HTF，Bravo Hotel Five Hotel Papa，Veronica'
  const c = context(text)
  assert.equal(checkCallsignDecision({ speaker: 'self', quote: text, callsign: 'BH5HP', evidence: 1 }, c).error, 'possibly-truncated-suffix')
  assert.deepEqual(supportedSelfEvidence(c), [])
})

test('finds retry evidence independently of an incorrect first self claim', () => {
  const text = '这里是 BG5GZX，这里是 BG5GBL，Bravo Golf Five Delta Bravo Lima'
  const c = context(text)
  const invalid = checkCallsignDecision({ speaker: 'self', quote: '这里是 BG5GZX', callsign: 'BG5GZX', evidence: null }, c)
  assert.equal(invalid.error, 'invalid-candidate-reference')
  const supported = supportedSelfEvidence(c)
  assert.deepEqual(supported.map(item => item.callsign), ['BG5DBL'])
  assert.ok(text.includes(supported[0]!.suggestedQuote))
})

test('raw extraction does not treat corrected display labels as extra evidence', () => {
  assert.deepEqual(extractCallsignEvidence({ id: 'raw', text: '这里是 BG5ATV' }), [])
})
