import type { CallsignExtraction } from '../../src/ai/callsign-extraction.js'
import type { LlmParserOptions } from '../../src/ai/llm-parser.js'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { LlmParser, validateAgainstSchema } from '../../src/ai/llm-parser.js'

const dir = mkdtempSync(join(tmpdir(), 'iaxweb-extraction-'))
const promptFile = join(dir, 'prompt.txt')
const schemaFile = join(dir, 'schema.json')
const schema = JSON.parse(readFileSync(new URL('../../../../examples/ai/schema.json', import.meta.url), 'utf8'))
writeFileSync(promptFile, '只提取自报与完整拼读，输出JSON。')
writeFileSync(schemaFile, JSON.stringify(schema))
after(() => rmSync(dir, { recursive: true, force: true }))

const SPELLING = 'Bravo Delta Five X-ray X-ray X-ray'
const TEXT = `这里是 ${SPELLING}`
const extraction: CallsignExtraction = {
  selfCallsigns: [{ identityEvidence: '这里是', quote: SPELLING, type: 'spelling', callsign: 'BD5XXX', confidence: 'high' }],
  spelledCallsigns: [{ sourceId: 'current', quote: SPELLING, correctedSpelling: SPELLING, callsign: 'BD5XXX', confidence: 'high' }],
}
function completion(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
}
interface CapturedCall {
  url: string
  body: {
    messages: Array<{ role: string, content: string }>
    thinking?: { type: string }
    enable_thinking?: boolean
    thinking_budget?: number
  }
}
function makeParser(content: string | (() => Response), options: Partial<LlmParserOptions> = {}) {
  const calls: CapturedCall[] = []
  const parser = new LlmParser({
    apiKey: 'test-key',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    promptFile,
    schemaFile,
    retryDelaysMs: [],
    ...options,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
      return typeof content === 'string' ? completion(content) : content()
    },
  })
  return { parser, calls }
}
function compact(callsign: string): CallsignExtraction {
  return { selfCallsigns: [{ identityEvidence: '这里是', quote: callsign, type: 'compact', callsign, confidence: 'medium' }], spelledCallsigns: [] }
}
const high = { callsign: 'BG5BUT', confidence: 'high' } as const
const medium = { ...high, confidence: 'medium' } as const
const but = 'Bravo Golf Five Bravo Uniform Tango'
const pastBut = { sourceId: 'past', quote: but, correctedSpelling: but, callsign: 'BG5BUT', confidence: 'high' } as const

test('extracts two arrays and computes a text result in one model call', async () => {
  const { parser, calls } = makeParser(JSON.stringify(extraction))
  const result = await parser.parse(TEXT)
  assert.equal(result?.callsign, 'BD5XXX')
  assert.equal(result?.algorithm, 'stage1_text')
  assert.deepEqual(result?.extraction, extraction)
  assert.equal(calls.length, 1)
  const call = calls[0]!
  assert.deepEqual(JSON.parse(call.body.messages[1]!.content), { current: { id: 'current', text: TEXT }, history: [] })
  assert.equal(call.url, 'https://api.deepseek.com/chat/completions')
  assert.equal(call.body.messages[0]!.content.includes('matchedCallsign'), false)
  assert.deepEqual(call.body.thinking, { type: 'disabled' })
})

test('B, 布 and 补 trigger extraction without requiring pre-parsed spelling', async () => {
  for (const text of ['这里是 BG5BUT', '这里是 布拉沃高尔夫五', '这里是 补拉窝高尔夫五']) {
    const { parser, calls } = makeParser(JSON.stringify({ selfCallsigns: [], spelledCallsigns: [] }))
    assert.equal((await parser.parse(text))?.callsign, undefined)
    assert.equal(calls.length, 1)
  }
})

test('no current trigger skips all decisions even with historical spelling and high features', async () => {
  const { parser, calls } = makeParser(JSON.stringify(extraction))
  const parsed = await parser.parse('收到，您的信号很清楚。', [{ id: 'past', text: TEXT }])
  assert.deepEqual(parsed, {})
  assert.equal(parser.resolve(parsed!, [high]), undefined)
  assert.equal(calls.length, 0)
})

test('Flower correction opens only the gate and raw text is sent unchanged', async () => {
  const raw = 'Flower Golf Five Hotel Echo Zulu，这里 Flower Hotel Four Hotel Yankee X-ray，是否能够抄收？'
  const { parser, calls } = makeParser(JSON.stringify({ selfCallsigns: [], spelledCallsigns: [] }))
  await parser.parse(raw)
  const payload = JSON.parse(calls[0]!.body.messages[1]!.content)
  assert.equal(payload.current.text, raw)
  assert.equal(payload.corrected, undefined)
  assert.equal(payload.candidates, undefined)
  assert.equal(payload.featureMatches, undefined)
})

test('matches a three-character self suffix to independent historical spelling and excludes the current record', async () => {
  const current = '这里是 XXX，BG5EBE 收到吗？'
  const value = { ...compact('XXX'), spelledCallsigns: [{ ...extraction.spelledCallsigns[0]!, sourceId: 'past' }] }
  const { parser, calls } = makeParser(JSON.stringify(value))
  const history = [{ id: 'past', text: TEXT }, { id: 'current', text: current }]
  const metadata = { id: 'current', transmissionId: 'transmission', partIndex: 2 }
  const parsed = await parser.parse(current, history, metadata)
  assert.equal(parsed?.callsign, 'BD5XXX')
  assert.equal(parsed?.algorithm, 'stage1_text')
  assert.deepEqual(JSON.parse(calls[0]!.body.messages[1]!.content), { current: { ...metadata, text: current }, history: [history[0]] })
})

test('filters invalid spelling candidates without losing valid evidence', async () => {
  const value = { ...extraction, spelledCallsigns: [...extraction.spelledCallsigns, { ...extraction.spelledCallsigns[0]!, callsign: 'BG5FGBR' }, { ...extraction.spelledCallsigns[0]!, quote: '不存在的原文', callsign: 'BG5BUT' }] }
  const { parser } = makeParser(JSON.stringify(value))
  const parsed = await parser.parse(TEXT)
  assert.equal(parsed?.callsign, 'BD5XXX')
  assert.equal(parsed?.extraction?.spelledCallsigns.some(item => item.callsign === 'BG5FGBR'), false)
  assert.equal(parsed?.prepared?.input.spellings.some(item => item.callsign === 'BG5BUT'), false)
})

test('rejects malformed model structure and extra conclusion fields', async () => {
  for (const content of [
    { selfCallsigns: null, spelledCallsigns: [] },
    { ...extraction, matchedCallsign: 'BG5BUT' },
    { ...extraction, selfCallsigns: [{ ...extraction.selfCallsigns[0], confidence: 'certain' }] },
    { selfCallsign: 'BG5BUT', spelledCallsigns: [] },
  ]) {
    const { parser, calls } = makeParser(JSON.stringify(content))
    const result = await parser.parse(TEXT)
    assert.deepEqual(result, {})
    assert.equal(parser.resolve(result!, [high]), undefined)
    assert.equal(calls.length, 1)
  }
})

test('an LLM self corroborated by features or a tail remains algorithm stage 1', async () => {
  const { parser, calls } = makeParser(JSON.stringify(compact('BG5BUD')))
  const parsed = await parser.parse('这里是 BG5BUD')
  assert.equal(parsed?.callsign, undefined)
  assert.deepEqual(parser.resolve(parsed!, [medium]), { callsign: 'BG5BUT', algorithm: 'stage1_text' })
  assert.deepEqual(parser.resolve(parsed!, [], [{ type: 'BSS', content: 'BG5BUT/P' }]), { callsign: 'BG5BUT', algorithm: 'stage1_text' })
  assert.equal(calls.length, 1)
})

test('an incomplete self is downgraded and must match exactly when effective confidence is low', async () => {
  for (const [self, expected] of [['BUT', 'BG5BUT'], ['BUD', undefined], ['UT', undefined]]) {
    const { parser } = makeParser(JSON.stringify(compact(self!)))
    const parsed = await parser.parse(`这里是 ${self}，B`)
    assert.equal(parser.resolve(parsed!, [high])?.callsign, expected)
    assert.equal(parser.resolve(parsed!, [medium]), undefined)
  }
})

test('only genuinely missing self can use a downgraded feature substitute and becomes stage 2', async () => {
  const value: CallsignExtraction = { selfCallsigns: [], spelledCallsigns: [pastBut] }
  const { parser, calls } = makeParser(JSON.stringify(value))
  const parsed = await parser.parse('BG5EBE收到', [{ id: 'past', text: but }])
  assert.deepEqual(parser.resolve(parsed!, [high]), { callsign: 'BG5BUT', algorithm: 'stage2_feature' })
  assert.deepEqual(parser.resolve(parsed!, [medium]), { callsign: 'BG5BUT', algorithm: 'stage2_feature' })
  assert.equal(parser.resolve(parsed!, [{ ...high, confidence: 'low' }]), undefined)
  assert.equal(calls.length, 1)

  const invalid = makeParser(JSON.stringify({ ...value, selfCallsigns: [{ ...compact('BG5G1').selfCallsigns[0]! }] }))
  const invalidParsed = await invalid.parser.parse('这里是 BG5G1', [{ id: 'past', text: but }])
  assert.equal(invalid.parser.resolve(invalidParsed!, [high]), undefined)
})

test('highest tier is selected before matching and ambiguity is not broken by an exact-match preference', async () => {
  const { parser } = makeParser(JSON.stringify(compact('BG5BUT')))
  const parsed = await parser.parse('这里是 BG5BUT')
  const far = { callsign: 'BG5XYZ', confidence: 'high' } as const
  const close = { callsign: 'BG5BUV', confidence: 'high' } as const
  assert.equal(parser.resolve(parsed!, [far, medium]), undefined)
  assert.equal(parser.resolve(parsed!, [close, high]), undefined)
  assert.deepEqual(parser.resolve(parsed!, [far, high, high]), { callsign: 'BG5BUT', algorithm: 'stage1_text' })
})

test('resolve preserves a direct spelled self and makes no further model requests', async () => {
  const { parser, calls } = makeParser(JSON.stringify(extraction))
  const parsed = await parser.parse(TEXT)
  assert.deepEqual(parser.resolve(parsed!, [high]), { callsign: 'BD5XXX', algorithm: 'stage1_text' })
  assert.equal(calls.length, 1)
})

test.todo('known deferred counterexample: no-self intersection can accept an explicit repetition of the other station (TODO.md)')

test('prompt/schema reload fails closed, including a valid legacy scalar schema', async () => {
  const own = mkdtempSync(join(tmpdir(), 'iaxweb-prompt-reload-'))
  const prompt = join(own, 'prompt.txt')
  const modelSchema = join(own, 'schema.json')
  try {
    writeFileSync(prompt, '第一版JSON')
    writeFileSync(modelSchema, JSON.stringify(schema))
    const { parser, calls } = makeParser(JSON.stringify(extraction), { promptFile: prompt, schemaFile: modelSchema })
    assert.equal((await parser.parse(TEXT))?.callsign, 'BD5XXX')
    writeFileSync(prompt, '第二版JSON')
    assert.equal((await parser.parse(TEXT))?.callsign, 'BD5XXX')
    assert.ok(calls[1]!.body.messages[0]!.content.includes('第二版JSON'))
    const incompatible = structuredClone(schema)
    incompatible.properties.selfCallsigns.items.properties.quote = { type: 'number' }
    for (const invalid of ['', '{', '[]', JSON.stringify({ type: 'object', properties: { selfCallsign: { type: 'string' } } }), JSON.stringify(incompatible)]) {
      writeFileSync(modelSchema, invalid)
      assert.equal(await parser.parse(TEXT), undefined)
    }
    writeFileSync(modelSchema, JSON.stringify(schema))
    writeFileSync(prompt, ' ')
    assert.equal(await parser.parse(TEXT), undefined)
    rmSync(prompt)
    assert.equal(await parser.parse(TEXT), undefined)
    assert.equal(calls.length, 2)
  }
  finally {
    rmSync(own, { recursive: true, force: true })
  }
})

test('handles fences, malformed replies and transport retries without semantic rechecks', async () => {
  const { parser } = makeParser(`\`\`\`json\n${JSON.stringify(extraction)}\n\`\`\``)
  assert.equal((await parser.parse(TEXT))?.callsign, 'BD5XXX')
  for (const content of ['', '不是JSON', '{}']) {
    const invalid = makeParser(content)
    assert.deepEqual(await invalid.parser.parse(TEXT), {})
    assert.equal(invalid.calls.length, 1)
  }
  let attempts = 0
  const retried = makeParser(() => ++attempts === 1 ? new Response('busy', { status: 503 }) : completion(JSON.stringify(extraction)), { retryDelaysMs: [0] })
  assert.equal((await retried.parser.parse(TEXT))?.callsign, 'BD5XXX')
  assert.equal(retried.calls.length, 2)
})

test('sends configurable provider-specific thinking settings with thinking disabled by default', async () => {
  const qwen = makeParser(JSON.stringify(extraction), { baseUrl: 'https://llm.example/v1', enableThinking: true, thinkingBudget: 1024 })
  await qwen.parser.parse(TEXT)
  assert.equal(qwen.calls[0]!.body.enable_thinking, true)
  assert.equal(qwen.calls[0]!.body.thinking_budget, 1024)
  const deepseek = makeParser(JSON.stringify(extraction), { thinkingBudget: 1024 })
  await deepseek.parser.parse(TEXT)
  assert.deepEqual(deepseek.calls[0]!.body.thinking, { type: 'disabled' })
  assert.equal(deepseek.calls[0]!.body.thinking_budget, undefined)
})

test('schema contains only the two evidence arrays and no model-provided conclusion', () => {
  assert.deepEqual(schema.required, ['selfCallsigns', 'spelledCallsigns'])
  assert.equal(schema.properties.matchedCallsign, undefined)
  assert.equal(validateAgainstSchema(extraction, schema), undefined)
  assert.ok(validateAgainstSchema({ ...extraction, matchedCallsign: 'BD5XXX' }, schema))
})
