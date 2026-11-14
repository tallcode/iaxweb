/** Corrected-only replacement comparison. Candidate/identity pipeline is frozen. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { buildCallsignContext } from '../../apps/backend/src/ai/callsign-evidence.js'
import { correctExplanationText as revised } from '../../apps/backend/src/ai/corrected-transcript.js'
import { correctExplanationText as legacy, shouldIncludeCallsignCorrection } from '../../apps/backend/src/ai/phonetic-corrector.js'
import { nearSpellingCorrections } from '../../apps/backend/src/ai/phonetic-near.js'
import { repo } from './paths.js'

const folder = resolve(repo, 'data/callsign-investigation/phonetic-research/corrected-only-round1')
mkdirSync(folder, { recursive: true })
const data = resolve(repo, 'data/callsign-investigation/phonetic-research')
const previous = JSON.parse(readFileSync(resolve(data, 'text-hybrid-round1/results.json'), 'utf8')) as { results: { key: string, text: string, legacyCorrections: { source: string, canonical: string, language: string, method: string }[] }[] }
const frozen = JSON.parse(readFileSync(resolve(data, 'text-integration/baseline.json'), 'utf8')) as { hashes: Record<string, string>, rows: { current: { id: string, text: string }, history: { id: string, text: string }[], context: unknown }[] }
for (const file of ['callsign-evidence.ts', 'callsign-speaker.ts', 'llm-parser.ts', 'phonetic-corrector.ts'])
  assert.equal(createHash('sha256').update(readFileSync(resolve(repo, 'apps/backend/src/ai', file))).digest('hex'), frozen.hashes[file])
for (const row of frozen.rows)
  assert.deepEqual(buildCallsignContext(row.current, row.history), row.context)
const panel = JSON.parse(readFileSync(resolve(data, 'text-hybrid-round1/ordinary-panel.json'), 'utf8')) as { rows: { sha256: string }[] }
const ordinary = new Set(panel.rows.map(row => row.sha256))
const rows = []
const lostNaive = []
const lostRevised = []
const times = []
for (const row of previous.results) {
  const old = legacy(row.text)
  const near = nearSpellingCorrections(row.text)
  let naive = row.text
  for (const correction of [...near].sort((a, b) => b.start - a.start))
    naive = naive.slice(0, correction.start) + correction.replacement[0]!.toUpperCase() + correction.replacement.slice(1) + naive.slice(correction.end)
  const start = performance.now()
  const next = revised(row.text)
  times.push(performance.now() - start)
  // All previously useful whole-word corrections are checked. Exclude the
  // observed bad multiword thanks rewrite, bare X, and substrings of codes.
  const useful = old.corrections.filter(c => c.method !== 'cmudict-window' && c.source.length > 1 && (c.language === 'zh' || new RegExp(`(?<![A-Za-z0-9])${c.source}(?![A-Za-z0-9])`, 'i').test(row.text)))
  const seen = new Map<string, number>()
  for (const correction of useful) {
    const key = JSON.stringify([correction.source, correction.canonical])
    const expectedCount = (seen.get(key) ?? 0) + 1
    seen.set(key, expectedCount)
    // Count repairs of the original word, not an unrelated canonical word
    // that happened to occur elsewhere in the same transcript.
    if (near.filter(c => c.source === correction.source && c.replacement === correction.canonical).length < expectedCount)
      lostNaive.push({ text: row.text, correction })
    if (next.corrections.filter(c => c.source === correction.source && c.canonical === correction.canonical).length < expectedCount)
      lostRevised.push({ text: row.text, correction })
  }
  for (const correction of next.corrections)
    assert.equal(row.text.slice(correction.start, correction.end), correction.source)
  rows.push({ ...row, old: old.text, naive, revised: next.text, corrections: next.corrections, ordinary: ordinary.has(row.key), usefulOldCorrections: useful, oldSentToLlm: shouldIncludeCallsignCorrection(row.text, old.text), revisedSentToLlm: shouldIncludeCallsignCorrection(row.text, next.text) })
}
assert.equal(lostRevised.length, 0, 'Previously useful whole-word repairs must survive')
// Separate synthetic boundary checks from all historical ASR counts.
const controls = [
  { text: '高尔夫，回拜克，帕帕', near: 'quebec' },
  { text: '高尔夫，主路，帕帕', near: 'zulu' },
  { text: '高尔夫，是吗，帕帕', near: undefined },
  { text: '高尔夫，出个，帕帕', near: undefined },
  ...['回拜克', '主路', 'thank you', 'Veronica', 'Flower', 'Gemini', 'BG5FAX', 'BD1ESL', '钻石 X300，设备 FTM-300', 'Bravo Germany Five Foxtrot Bravo, thank you'].map(text => ({ text, near: undefined, unchanged: true })),
  ...['X Ray', 'x ray', 'X   Ray', 'X-ray', 'Xray'].map(spelling => ({ text: `Bravo Golf Five Golf ${spelling} Delta`, near: undefined, unchanged: true })),
].map((row) => {
  const output = revised(row.text)
  const near = output.corrections.filter(c => c.method === 'ipa-near')
  assert.deepEqual(near.map(c => c.canonical), row.near ? [row.near] : [])
  if ('unchanged' in row && row.unchanged)
    assert.equal(output.text, row.text)
  return { ...row, output }
})
const budgetText = '高尔夫，回拜克，帕帕。高尔夫，回拜克，帕帕。'
assert.equal(revised(budgetText).corrections.filter(c => c.method === 'ipa-near').length, 1)
const sorted = times.sort((a, b) => a - b)
const sourceHashes = Object.fromEntries(['corrected-transcript.ts', 'phonetic-near.ts', 'phonetic-near-context.ts', 'phonetic-data/data.ts', 'service.ts', 'callsign-evidence.ts', 'callsign-speaker.ts', 'llm-parser.ts', 'phonetic-corrector.ts'].map(file => [file, createHash('sha256').update(readFileSync(resolve(repo, 'apps/backend/src/ai', file))).digest('hex')]))
const result = { scope: '530 existing distinct ASR texts. Only corrected is replaced; all four candidate/identity source hashes and 1100 contexts remain identical. No cloud/model calls.', uniqueTexts: rows.length, unchangedCandidateContexts: frozen.rows.length, oldUsefulRepairPositions: rows.reduce((n, row) => n + row.usefulOldCorrections.length, 0), naiveLostUsefulPositions: lostNaive.length, revisedLostUsefulPositions: lostRevised.length, oldChangedTexts: rows.filter(r => r.old !== r.text).length, naiveChangedTexts: rows.filter(r => r.naive !== r.text).length, revisedChangedTexts: rows.filter(r => r.revised !== r.text).length, ordinaryPanel: { size: ordinary.size, oldChanged: rows.filter(r => r.ordinary && r.old !== r.text).length, revisedChanged: rows.filter(r => r.ordinary && r.revised !== r.text).length }, changedAgainstLegacy: rows.filter(row => row.old !== row.revised).map(row => ({ text: row.text, old: row.old, revised: row.revised, corrections: row.corrections })), correctedPayloadChanges: rows.filter(r => r.oldSentToLlm !== r.revisedSentToLlm || (r.oldSentToLlm && r.old !== r.revised)).length, lostNaive, lostRevised, syntheticControls: controls, oneNearEditBudgetPassed: true, runtimeMs: { median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.floor(sorted.length * 0.95)], maximum: sorted.at(-1) }, warning: 'Lexical preservation and error audit, not a fresh LLM accuracy evaluation. The auxiliary corrected input may change model behavior; raw evidence and ownership rules are unchanged.', rows }
writeFileSync(resolve(folder, 'evaluation.json'), JSON.stringify({ ...result, sourceHashes }, null, 2))
console.log(JSON.stringify({ ...result, rows: undefined, changedAgainstLegacy: undefined, lostNaive: undefined, syntheticControls: controls.length }, null, 2))
