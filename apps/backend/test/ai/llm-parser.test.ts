import type { CallsignExtraction } from '../../src/ai/callsign-extraction.js'
import type { LlmParserOptions, ParsedTranscript } from '../../src/ai/llm-parser.js'
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

const TEXT = '这里是 Bravo Delta Five X-ray X-ray X-ray'
const extraction: CallsignExtraction = {
  selfCallsignEvidence: TEXT,
  spelledCallsignEvidence: [{ quote: 'Bravo Delta Five X-ray X-ray X-ray', callsign: 'BD5XXX' }],
  selfCallsign: 'BD5XXX',
  spelledCallsigns: ['BD5XXX'],
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
    analysisEnabled: false,
    retryDelaysMs: [],
    ...options,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
      return typeof content === 'string' ? completion(content) : content()
    },
  })
  return { parser, calls }
}
function partial(self: string | null, spelled: string[] = []): ParsedTranscript {
  return { extraction: {
    selfCallsignEvidence: self ? `这里是 ${self}` : null,
    selfCallsign: self,
    spelledCallsignEvidence: spelled.map(callsign => ({ quote: '已校验的原文证据', callsign })),
    spelledCallsigns: spelled,
  } }
}
const high = { callsign: 'BG5BUT', confidence: 'high' } as const
const medium = { ...high, confidence: 'medium' } as const

test('extracts four model fields and computes the final call without candidate parsing', async () => {
  const { parser, calls } = makeParser(JSON.stringify(extraction))
  const result = await parser.parse(TEXT)
  assert.equal(result?.callsign, 'BD5XXX')
  assert.deepEqual(result?.extraction, extraction)
  assert.equal(calls.length, 1)
  const call = calls[0]!
  const payload = JSON.parse(call.body.messages[1]!.content)
  assert.deepEqual(payload, { history: [], current: { id: 'current', text: TEXT } })
  assert.equal(call.url, 'https://api.deepseek.com/chat/completions')
  assert.equal(call.body.messages[0]!.content.includes('matchedCallsign'), false)
  assert.deepEqual(call.body.thinking, { type: 'disabled' })
})

test('B, 布 and 补 trigger extraction without requiring pre-parsed spelling', async () => {
  for (const text of ['这里是 BG5BUT', '这里是 布拉沃高尔夫五', '这里是 补拉窝高尔夫五']) {
    const value = { ...extraction, selfCallsignEvidence: text, spelledCallsignEvidence: [], spelledCallsigns: [] }
    const { parser, calls } = makeParser(JSON.stringify(value))
    assert.equal((await parser.parse(text))?.callsign, undefined)
    assert.equal(calls.length, 1)
  }
})

test('no current trigger skips both stages even with historical spelling and a high feature match', async () => {
  const { parser, calls } = makeParser(JSON.stringify(extraction), { analysisEnabled: true })
  const parsed = await parser.parse('收到，您的信号很清楚。', [{ id: 'past', text: TEXT }])
  assert.deepEqual(parsed, {})
  assert.equal(parser.parseStage2(parsed!, [high]), undefined)
  assert.equal(calls.length, 0)
})

test('Flower correction opens only the gate and is never sent as corrected input', async () => {
  const raw = 'Flower Golf Five Hotel Echo Zulu，这里 Flower Hotel Four Hotel Yankee X-ray，是否能够抄收？'
  const value = { selfCallsignEvidence: '这里 Flower Hotel Four Hotel Yankee X-ray', selfCallsign: 'BH4HYX', spelledCallsignEvidence: [{ quote: 'Flower Hotel Four Hotel Yankee X-ray', callsign: 'BH4HYX' }], spelledCallsigns: ['BH4HYX'] }
  const { parser, calls } = makeParser(JSON.stringify(value))
  assert.equal((await parser.parse(raw, [], 'Bravo Golf Five Hotel Echo Zulu'))?.callsign, 'BH4HYX')
  const payload = JSON.parse(calls[0]!.body.messages[1]!.content)
  assert.equal(payload.current.text, raw)
  assert.equal(payload.corrected, undefined)
  assert.equal(payload.candidates, undefined)
  assert.equal(payload.featureMatches, undefined)
})

test('matches a self suffix to complete historical spelling while excluding the current record', async () => {
  const current = '这里是 XXX，BG5EBE 收到吗？'
  const value = { ...extraction, selfCallsignEvidence: current, selfCallsign: 'XXX' }
  const { parser, calls } = makeParser(JSON.stringify(value))
  const history = [{ id: 'past', text: TEXT }, { id: 'current', text: current }]
  assert.equal((await parser.parse(current, history))?.callsign, 'BD5XXX')
  assert.deepEqual(JSON.parse(calls[0]!.body.messages[1]!.content).history, [history[0]])
})

test('cleans duplicate, nonverbatim and malformed spelling without changing the self decision', async () => {
  const value = { ...extraction, spelledCallsignEvidence: [...extraction.spelledCallsignEvidence, ...extraction.spelledCallsignEvidence, { quote: '不存在的原文', callsign: 'BG5BUT' }, { quote: TEXT, callsign: 'BD5X' }], spelledCallsigns: ['BD5XXX', 'BG5BUT', 'BD5X'] }
  const { parser } = makeParser(JSON.stringify(value))
  assert.deepEqual((await parser.parse(TEXT))?.extraction, extraction)
})

test('rejects fabricated self evidence, inconsistent identity fields, old protocol and model matching decisions', async () => {
  for (const content of [
    { ...extraction, selfCallsignEvidence: '这里是模型编造的呼号' },
    { ...extraction, selfCallsign: null },
    { ...extraction, selfCallsignEvidence: ' ' },
    { speaker: 'self', callsign: 'BD5XXX' },
    { ...extraction, matchedCallsign: 'BG5BUT' },
    { ...extraction, extra: true },
  ]) {
    const { parser, calls } = makeParser(JSON.stringify(content))
    const result = await parser.parse(TEXT)
    assert.deepEqual(result, {})
    assert.equal(parser.parseStage2(result!, [high]), undefined)
    assert.equal(calls.length, 1)
  }
})

test('no spelling requires high confidence and a suffix of at least three characters within one edit', () => {
  const { parser, calls } = makeParser('{}')
  for (const self of ['BUT', 'BUD', '5BUD', 'BD5BUD'])
    assert.equal(parser.parseStage2(partial(self), [high]), 'BG5BUT')
  for (const self of ['UT', 'BG5G', 'XYZ', 'BAD'])
    assert.equal(parser.parseStage2(partial(self), [high]), undefined)
  assert.equal(parser.parseStage2(partial('BUT'), [medium]), undefined)
  assert.equal(parser.parseStage2(partial(null), [high]), undefined)
  assert.equal(calls.length, 0)
})

test('conflicts require exact full spelling intersection as well as a close self suffix', () => {
  const { parser } = makeParser('{}')
  assert.equal(parser.parseStage2(partial('BUD', ['BG5BUT']), [medium]), 'BG5BUT')
  assert.equal(parser.parseStage2(partial('XYZ', ['BG5BUT']), [high]), undefined)
  assert.equal(parser.parseStage2(partial('UT', ['BG5BUT']), [high]), undefined)
  assert.equal(parser.parseStage2(partial('BUD', ['BG5BUV']), [high]), undefined)
  assert.equal(parser.parseStage2(partial('BUD', ['BD5BUT']), [high]), undefined)
})

test('no-self fallback uses exact spelling with the highest medium/high tier', () => {
  const { parser } = makeParser('{}')
  assert.equal(parser.parseStage2(partial(null, ['BG5BUT']), [medium]), 'BG5BUT')
  assert.equal(parser.parseStage2(partial(null, ['BG5BUD']), [high]), undefined)
  assert.equal(parser.parseStage2(partial(null, ['BD5BUT']), [high]), undefined)
  assert.equal(parser.parseStage2(partial(null, ['BG5BUT']), [{ ...high, confidence: 'low' }]), undefined)
})

test('never falls back to medium after high fails and requires a unique full call after filtering', () => {
  const { parser } = makeParser('{}')
  const close = { callsign: 'BG5BUV', confidence: 'high' } as const
  const far = { callsign: 'BG5XYZ', confidence: 'high' } as const
  assert.equal(parser.parseStage2(partial('BUD'), [far, medium]), undefined)
  assert.equal(parser.parseStage2(partial('BUD'), [close, high]), undefined)
  assert.equal(parser.parseStage2(partial('BUD'), [far, high, high]), 'BG5BUT')
  assert.equal(parser.parseStage2(partial('BUD', ['BG5BUT', 'BG5XYZ']), [far, high]), 'BG5BUT')
  assert.equal(parser.parseStage2(partial(null, ['BG5BUT', 'BG5XYZ']), [far, high]), undefined)
  assert.equal(parser.parseStage2(partial(null, ['BG5BUT']), [far, medium]), undefined)
})

test('Stage 2 preserves a first-stage match and performs no model requests', async () => {
  const { parser, calls } = makeParser(JSON.stringify(extraction))
  const parsed = await parser.parse(TEXT)
  assert.equal(parser.parseStage2(parsed!, [high]), 'BD5XXX')
  assert.equal(calls.length, 1)
})

test.todo('known deferred counterexample: no-self intersection can accept an explicit repetition of the other station (TODO.md)')

test('full analysis shares the extraction schema and still requires message and risk', async () => {
  const response = { ...extraction, message: '规范化文本', risk: { level: 1, reason: '正常' } }
  const { parser } = makeParser(JSON.stringify(response), { analysisEnabled: true })
  const parsed = await parser.parse(TEXT)
  assert.equal(parsed?.callsign, 'BD5XXX')
  assert.equal(parsed?.message, response.message)
  assert.deepEqual(parsed?.risk, response.risk)
  const invalid = makeParser(JSON.stringify(extraction), { analysisEnabled: true })
  assert.deepEqual(await invalid.parser.parse(TEXT), {})
})

test('prompt/schema hot reload fails closed instead of using stale or default configuration', async () => {
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
    for (const invalid of ['', '{', '[]']) {
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

test('schema contains four required extraction fields and forbids a model-provided matchedCallsign', () => {
  assert.deepEqual(schema.required, ['selfCallsignEvidence', 'spelledCallsignEvidence', 'selfCallsign', 'spelledCallsigns'])
  assert.equal(schema.properties.matchedCallsign, undefined)
  assert.equal(validateAgainstSchema(extraction, schema), undefined)
  assert.ok(validateAgainstSchema({ ...extraction, matchedCallsign: 'BD5XXX' }, schema))
})
