import type { LlmParserOptions } from '../../src/ai/llm-parser.js'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { LlmParser, validateAgainstSchema } from '../../src/ai/llm-parser.js'

const fixtureDir = mkdtempSync(join(tmpdir(), 'iaxweb-llm-'))
const fixturePrompt = join(fixtureDir, 'prompt.txt')
const fixtureSchema = join(fixtureDir, 'schema.json')
const modelSchema = JSON.parse(readFileSync(new URL('../../../../examples/ai/schema.json', import.meta.url), 'utf8'))
writeFileSync(fixturePrompt, combinedPrompts('测试提示词，输出JSON'))
writeFileSync(fixtureSchema, JSON.stringify(modelSchema))
after(() => rmSync(fixtureDir, { force: true, recursive: true }))

const TRANSCRIPT = '这里是 Bravo Delta Five X-ray X-ray X-ray'
function combinedPrompts(stage1: string, stage2 = '普通补证', review = '冲突复核'): string {
  return [stage1, '######### 📝 普通补证', stage2, '######### 冲突复核 #########', review].join('\r\n')
}

function completion(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { headers: { 'content-type': 'application/json' }, status: 200 })
}
function okResult({ quote = TRANSCRIPT, evidence = 1, ...overrides }: Record<string, unknown> = {}): string {
  return JSON.stringify({
    speaker: 'self',
    callsign: 'BD5XXX',
    speakerEvidence: { source: 'text', quote },
    callsignEvidence: { source: 'spelling', candidateId: evidence },
    message: 'BD5XXX 呼叫 CQ，杭州',
    risk: { level: 1, reason: '正常' },
    ...overrides,
  })
}
interface CapturedCall {
  body: { enable_thinking?: boolean, messages: Array<{ content: string, role: string }>, response_format?: { type?: string }, thinking?: { type?: string }, thinking_budget?: number }
  url: string
}
function makeParser(
  fetchImpl: typeof fetch,
  files: Partial<Pick<LlmParserOptions, 'analysisEnabled' | 'promptFile' | 'schemaFile'>> = {},
  extra: { baseUrl?: string, enableThinking?: boolean, thinkingBudget?: number } = {},
): { calls: CapturedCall[], parser: LlmParser } {
  const calls: CapturedCall[] = []
  const parser = new LlmParser({
    analysisEnabled: true,
    apiKey: 'test-key',
    baseUrl: extra.baseUrl ?? 'https://llm.example/v1',
    model: 'qwen3.7-flash',
    ...extra,
    fetchImpl: (url, init) => {
      calls.push({ body: JSON.parse(String(init?.body)), url: String(url) })
      return fetchImpl(url, init)
    },
    ...files,
    promptFile: files.promptFile ?? fixturePrompt,
    schemaFile: files.schemaFile ?? fixtureSchema,
    retryDelaysMs: [0],
  })
  return { calls, parser }
}

test('accepts only a current speaker with matching explanation evidence', async () => {
  const { calls, parser } = makeParser(() => Promise.resolve(completion(okResult())))
  const parsed = await parser.parse(TRANSCRIPT)
  assert.deepEqual(parsed, { callsign: 'BD5XXX', message: 'BD5XXX 呼叫 CQ，杭州', risk: { level: 1, reason: '正常' } })
  assert.equal(calls[0]?.url, 'https://llm.example/v1/chat/completions')
  assert.equal(calls[0]?.body.response_format?.type, 'json_object')
  assert.equal(calls[0]?.body.enable_thinking, undefined)
  const payload = JSON.parse(calls[0]!.body.messages[1]!.content)
  assert.equal(payload.current.text, TRANSCRIPT)
  assert.equal(payload.candidates[0].callsign, 'BD5XXX')
  assert.equal(payload.candidates[0].start, undefined)
  assert.equal(payload.candidates[0].end, undefined)
})

test('normalizes callsign values without accepting the old Callsign key', async () => {
  const { parser } = makeParser(() => Promise.resolve(completion(okResult({ callsign: ' bd5xxx ' }))))
  assert.equal((await parser.parse(TRANSCRIPT))?.callsign, 'BD5XXX')
  const old = makeParser(() => Promise.resolve(completion(okResult({ callsign: undefined, Callsign: 'BD5XXX' }))))
  assert.deepEqual(await old.parser.parse(TRANSCRIPT), {})
})

test('skips callsign-only requests without explanation evidence', async () => {
  const { calls, parser } = makeParser(() => Promise.resolve(completion('{}')), { analysisEnabled: false })
  for (const text of ['这里是 BG5ATV', '这里是 B G 五 A T V', '这里是 BD1ESL'])
    assert.deepEqual(await parser.parse(text), {})
  assert.equal(calls.length, 0)
})

test('stage 2 uses a unique high match, and requires a spelling candidate for a medium match', async () => {
  const match = { source: 'featureMatch', matchId: 1 }
  const context = { id: 'current' }
  const text = '收到，您的信号很清楚。'
  const high = { callsign: 'BG5XYZ', confidence: 'high' } as const
  const medium = { ...high, confidence: 'medium' } as const
  const { calls, parser } = makeParser(() => Promise.resolve(completion(JSON.stringify({ speaker: 'self', callsign: high.callsign, speakerEvidence: match, callsignEvidence: match }))))
  assert.equal(await parser.parseStage2(text, [], text, context, [high]), 'BG5XYZ')
  assert.equal(await parser.parseStage2(text, [], text, context, [medium]), undefined)
  assert.equal(await parser.parseStage2(text, [], text, context, [{ callsign: 'BG5ABC', confidence: 'medium' }, high, { callsign: 'BG5KLM', confidence: null }]), 'BG5XYZ')
  assert.equal(await parser.parseStage2('这里是 BG5ABC', [], text, context, [high]), undefined)
  assert.equal(await parser.parseStage2('我抄收您的呼号是 Bravo Golf Five X Ray Yankee Zulu', [], text, context, [high]), undefined)
  assert.equal(calls.length, 2)
  assert.deepEqual(JSON.parse(calls[1]!.body.messages[1]!.content).featureMatches, [{ id: 1, ...high }])

  const history = [{ id: 'prior', text: '这里是 Bravo Golf Five X Ray Yankee Zulu' }]
  const spell = { source: 'spelling', candidateId: 1 }
  const mixed = makeParser(() => Promise.resolve(completion(JSON.stringify({ speaker: 'self', callsign: high.callsign, speakerEvidence: match, callsignEvidence: spell }))))
  assert.equal(await mixed.parser.parseStage2(text, history, text, context, [medium]), 'BG5XYZ')
  assert.equal(await mixed.parser.parseStage2(text, history, text, context, [{ callsign: 'BG5ABC', confidence: 'low' }, medium]), 'BG5XYZ')
  assert.equal(await parser.parseStage2(text, history, text, context, [medium]), undefined)
  assert.equal(await parser.parseStage2('这里是 BG5XYZ', [], text, context, [high]), undefined)
})

test('stage 2 anchors one-character self-call conflicts to the same introduction', async () => {
  const text = 'BG5EBE，这里是BG5BUD，Bravo杠Five，Bravo Uniform Tango，抄你信号五九。'
  const callsign = 'BG5BUT'
  const decision = {
    speaker: 'self',
    callsign,
    speakerEvidence: { source: 'featureMatch', matchId: 1 },
    callsignEvidence: { source: 'spelling', candidateId: 1 },
  }
  const { calls, parser } = makeParser(() => Promise.resolve(completion(JSON.stringify(decision))), { analysisEnabled: false })
  assert.deepEqual(await parser.parse(text), {})
  assert.equal(calls.length, 0)
  for (const confidence of ['medium', 'high'] as const)
    assert.equal(await parser.parseStage2(text, [], text, { id: 'current' }, [{ callsign, confidence }]), callsign)
  assert.equal(calls.length, 2)
  const payload = JSON.parse(calls[0]!.body.messages[1]!.content)
  assert.deepEqual(payload.compactReview, {
    compactCallsign: 'BG5BUD',
    distance: 1,
    quote: '这里是BG5BUD，Bravo杠Five，Bravo Uniform Tango',
    spellingCandidateId: 1,
  })
  assert.deepEqual(payload.candidates, [{
    id: 1,
    segmentId: 'current',
    callsign,
    kind: 'suffix',
    quote: 'Bravo Uniform Tango',
    prefixQuote: 'BG5BUD',
  }])
})

test('stage 2 reviews a tied top tier only when exactly one callsign is one edit from the self-call', async () => {
  const text = '这里是BG5BUD，Bravo杠Five，Bravo Uniform Tango。'
  const result = {
    speaker: 'self',
    callsign: 'BG5BUT',
    speakerEvidence: { source: 'featureMatch', matchId: 1 },
    callsignEvidence: { source: 'spelling', candidateId: 1 },
  }
  const { calls, parser } = makeParser(() => Promise.resolve(completion(JSON.stringify(result))))
  const metadata = { id: 'current' }
  for (const confidence of ['high', 'medium'] as const) {
    const same = { callsign: 'BG5BUD', confidence }
    const close = { callsign: 'BG5BUT', confidence }
    const far = { callsign: 'BG5XYZ', confidence }
    assert.equal(await parser.parseStage2(text, [], text, metadata, [same, far]), undefined)
    assert.equal(await parser.parseStage2(text, [], text, metadata, [same, far, close]), result.callsign)
    const payload = JSON.parse(calls.at(-1)!.body.messages[1]!.content)
    assert.deepEqual(payload.featureMatches, [{ id: 1, ...close }])
    assert.equal(payload.compactReview.distance, 1)
  }
  assert.equal(calls.length, 2)
})

test('stage 2 rejects a nearby feature match unsupported by the same self-introduction', async () => {
  const text = '这里是BG5BUD，Bravo杠Five，Bravo Uniform Tango。'
  const decision = {
    speaker: 'self',
    callsign: 'BG5BUV',
    speakerEvidence: { source: 'featureMatch', matchId: 1 },
    callsignEvidence: { source: 'spelling', candidateId: 1 },
  }
  const metadata = { id: 'current' }
  const wrong = { callsign: decision.callsign, confidence: 'high' } as const
  const right = { ...wrong, callsign: 'BG5BUT' }
  const { calls, parser } = makeParser(() => Promise.resolve(completion(JSON.stringify(decision))))
  assert.equal(await parser.parseStage2(text, [], text, metadata, [wrong]), undefined)
  assert.equal(calls.length, 1)
  assert.equal(await parser.parseStage2(text, [], text, metadata, [right, wrong]), undefined)
  assert.equal(await parser.parseStage2(text, [], text, metadata, [{ ...right, confidence: 'low' }]), undefined)
  assert.equal(calls.length, 1)

  const claimed = { ...decision, callsign: right.callsign }
  const history = [{ id: 'prior', text: 'Bravo Golf Five Bravo Uniform Tango' }]
  const checked = makeParser(() => Promise.resolve(completion(JSON.stringify(claimed))))
  const separated = '这里是BG5BUD。Bravo Golf Five Bravo Uniform Tango。'
  assert.equal(await checked.parser.parseStage2(separated, history, separated, metadata, [right]), undefined)
  assert.equal(JSON.parse(checked.calls[0]!.body.messages[1]!.content).compactReview.spellingCandidateId, null)

  const featureOnly = { ...claimed, callsignEvidence: claimed.speakerEvidence }
  const unchecked = makeParser(() => Promise.resolve(completion(JSON.stringify(featureOnly))))
  assert.equal(await unchecked.parser.parseStage2(text, [], text, metadata, [right]), undefined)
})

test('stage 2 rejects spelling that loses a letter from the trailing self-call', async () => {
  const callsign = 'BG5GW'
  const decision = {
    speaker: 'self',
    callsign,
    speakerEvidence: { source: 'featureMatch', matchId: 1 },
    callsignEvidence: { source: 'spelling', candidateId: 1 },
  }
  const { calls, parser } = makeParser(() => Promise.resolve(completion(JSON.stringify(decision))))
  for (const prefix of ['这里是', '这里是 BG5GZW，']) {
    const text = `${prefix} Bravo Golf Five Golf Whiskey，BG5GZW。`
    assert.equal(await parser.parseStage2(text, [], text, { id: 'current' }, [{ callsign, confidence: 'high' }]), undefined)
  }
  assert.equal(calls.length, 2)
})

test('shares one model schema while enforcing different evidence rules', async () => {
  const normal = '收到，信号很好。'
  const conflict = '这里是BG5BUD，Bravo杠Five，Bravo Uniform Tango。'
  const callsign = 'BG5BUT'
  const feature = { source: 'featureMatch', matchId: 1 }
  let reply = okResult({ speakerEvidence: feature })
  const { parser, calls } = makeParser(() => Promise.resolve(completion(reply)), { analysisEnabled: false })
  assert.deepEqual(await parser.parse(TRANSCRIPT), {})

  const matches = [{ callsign, confidence: 'high' }] as const
  const metadata = { id: 'current' }
  reply = JSON.stringify({ speaker: 'self', callsign, speakerEvidence: feature, callsignEvidence: feature })
  assert.equal(await parser.parseStage2(normal, [], normal, metadata, matches), callsign)
  assert.equal(await parser.parseStage2(conflict, [], conflict, metadata, matches), undefined)

  const spelling = { source: 'spelling', candidateId: 1 }
  reply = JSON.stringify({ speaker: 'self', callsign, speakerEvidence: { ...feature, matchId: 2 }, callsignEvidence: spelling })
  assert.equal(await parser.parseStage2(conflict, [], conflict, metadata, matches), undefined)
  reply = JSON.stringify({ speaker: 'self', callsign, speakerEvidence: feature, callsignEvidence: spelling })
  assert.equal(await parser.parseStage2(conflict, [], conflict, metadata, matches), callsign)
  assert.equal(calls.length, 5)
  for (const { body } of calls)
    assert.ok(body.messages[0]?.content.endsWith(JSON.stringify(modelSchema)))
})

test('skips stage 2 for top-tier ties without a compact self-call and tiers below medium', async () => {
  const { calls, parser } = makeParser(() => Promise.resolve(completion('{"speaker":"unknown"}')))
  const current = '收到，信号很清楚。'
  const history = [{ id: 'prior', text: TRANSCRIPT }]
  const lower = { callsign: 'BG5ABC', confidence: 'low' } as const
  const metadata = { id: 'current' }
  for (const confidence of ['high', 'medium'] as const) {
    const matches = [lower, { callsign: 'BD5XXX', confidence }, { callsign: 'BG5XYZ', confidence }]
    assert.equal(await parser.parseStage2(current, history, current, metadata, matches), undefined)
  }
  for (const confidence of ['low', null] as const)
    assert.equal(await parser.parseStage2(current, history, current, metadata, [{ callsign: 'BD5XXX', confidence }, lower]), undefined)
  assert.equal(calls.length, 0)
})

test('hot loads the combined prompt file and skips model calls when it becomes invalid', async () => {
  const promptFile = join(fixtureDir, 'combined.txt')
  const { parser, calls } = makeParser(() => Promise.resolve(completion('{"speaker":"unknown"}')), { promptFile })
  const normal = '收到，信号很好。'
  const review = '这里是BG5BUD，Bravo杠Five，Bravo Uniform Tango。'
  const match = [{ callsign: 'BG5BUT', confidence: 'high' }] as const
  const check = async (text: string, prompt: string) => {
    await parser.parseStage2(text, [], text, { id: 'current' }, match)
    const system = calls.at(-1)?.body.messages[0]?.content
    assert.ok(system?.startsWith(prompt), system ?? 'missing model request')
  }
  writeFileSync(promptFile, combinedPrompts('一阶段 v1', '普通补证 v1', '冲突复核 v1'))
  await check(normal, '普通补证 v1')
  await check(review, '冲突复核 v1')
  writeFileSync(promptFile, combinedPrompts('一阶段 v2', '普通补证 v2', '冲突复核 v2'))
  await parser.parse(TRANSCRIPT)
  assert.ok(calls.at(-1)?.body.messages[0]?.content.startsWith('一阶段 v2\n\n'))
  await check(normal, '普通补证 v2')
  await check(review, '冲突复核 v2')
  const skips = async () => {
    assert.equal(await parser.parse(TRANSCRIPT), undefined)
    for (const text of [normal, review])
      assert.equal(await parser.parseStage2(text, [], text, { id: 'current' }, match), undefined)
    assert.equal(calls.length, 5)
  }
  for (const invalid of ['', '一阶段\n######### 二阶段\n普通补证', combinedPrompts('一阶段', '普通补证', '')]) {
    writeFileSync(promptFile, invalid)
    await skips()
  }
  rmSync(promptFile)
  await skips()
  mkdirSync(promptFile)
  await skips()
})

test('still runs full text and risk analysis without callsign evidence', async () => {
  const { calls, parser } = makeParser(() => Promise.resolve(completion(JSON.stringify({ speaker: 'unknown', message: '无呼号', risk: { level: 1, reason: '正常' } }))))
  assert.deepEqual(await parser.parse('只有普通对话'), { message: '无呼号', risk: { level: 1, reason: '正常' } })
  assert.equal(calls.length, 1)
})

test('never publishes a bare callsign invented by the model', async () => {
  const { calls, parser } = makeParser(() => Promise.resolve(completion(okResult({ callsign: 'BD1ESL', quote: '这里是 BD1ESL' }))))
  const parsed = await parser.parse('这里是 BD1ESL')
  assert.equal(parsed?.callsign, undefined)
  assert.equal(calls.length, 1)
})

test('does not recheck invalid stage 1 self claims', async () => {
  for (const response of [okResult({ evidence: 99 }), okResult({ evidence: null }), okResult({ quote: '模型编造的自报' })]) {
    const { calls, parser } = makeParser(() => Promise.resolve(completion(response)))
    assert.equal((await parser.parse(TRANSCRIPT))?.callsign, undefined)
    assert.equal(calls.length, 1)
  }
})

test('rejects confirmation and a callee before the current self-introduction', async () => {
  const other = 'Bravo Golf Five Alpha Tango Victor'
  for (const text of [`我抄收您的呼号是 ${other}，是否正确？`, `${other}，这里是 BG5TOX`]) {
    const { calls, parser } = makeParser(() => Promise.resolve(completion(okResult({ callsign: 'BG5ATV', quote: text }))))
    assert.equal((await parser.parse(text))?.callsign, undefined)
    assert.equal(calls.length, 1)
  }
})

test('links a current explicit self-identification to raw historical spelling', async () => {
  const current = '你抄收正确，这里是 BG5ATV'
  const history = [{ id: 'prior', text: 'Bravo Golf Five Alpha Tango Victor，我抄收是否正确？' }]
  const { calls, parser } = makeParser(() => Promise.resolve(completion(okResult({ callsign: 'BG5ATV', quote: '这里是 BG5ATV' }))))
  assert.equal((await parser.parse(current, history))?.callsign, 'BG5ATV')
  assert.deepEqual(JSON.parse(calls[0]!.body.messages[1]!.content).history, history)
})

test('allows only adjacent chunks of the same transmission to complete spelling', async () => {
  const current = 'X-ray X-ray X-ray'
  const history = [{ id: 'first', text: '这里是 Bravo Delta Five', transmissionId: 'tx', partIndex: 0 }]
  const response = okResult({ quote: current })
  const yes = makeParser(() => Promise.resolve(completion(response)), { analysisEnabled: false })
  // Use the full schema response for analysis, so configure full mode below.
  const full = makeParser(() => Promise.resolve(completion(response)))
  assert.equal((await full.parser.parse(current, history, current, { id: 'second', transmissionId: 'tx', partIndex: 1 }))?.callsign, 'BD5XXX')
  const payload = JSON.parse(full.calls[0]!.body.messages[1]!.content)
  assert.deepEqual(payload.current, { id: 'second', text: current })
  assert.deepEqual(payload.history, [{ id: 'first', text: history[0]!.text }])
  assert.equal(payload.candidates[0].kind, 'verified-continuation')
  assert.deepEqual(payload.candidates[0].segmentIds, ['first', 'second'])
  assert.deepEqual(await yes.parser.parse(current, history, current, { id: 'second', transmissionId: 'different', partIndex: 1 }), {})
  assert.equal(yes.calls.length, 0)
})

test('does not send similarity hints or accept a callsign outside the evidence', async () => {
  const text = '这里是 Bravo Golf Five Foxtrot Victor Tango'
  const { calls, parser } = makeParser(() => Promise.resolve(completion(okResult({ callsign: 'BG5FBT', quote: text }))))
  assert.equal((await parser.parse(text))?.callsign, undefined)
  const payload = JSON.parse(calls[0]!.body.messages[1]!.content)
  assert.equal(payload.candidates[0].callsign, 'BG5FVT')
  assert.equal(payload.similarityHints, undefined)
  assert.equal(payload.referenceCallsigns, undefined)
})

test('preserves raw current evidence beside an optional corrected transcript', async () => {
  const raw = '这里是 补拉窝 高尔夫 五 福克斯特罗特 维克托 探戈'
  const corrected = '这里是 Bravo Golf Five Foxtrot Victor Tango'
  const { calls, parser } = makeParser(() => Promise.resolve(completion(okResult({ callsign: 'BG5FVT', quote: raw }))))
  assert.equal((await parser.parse(raw, undefined, corrected))?.callsign, 'BG5FVT')
  const payload = JSON.parse(calls[0]!.body.messages[1]!.content)
  assert.equal(payload.current.text, raw)
  assert.equal(payload.corrected.text, corrected)
})

test('sends provider-specific thinking settings', async () => {
  const qwen = makeParser(() => Promise.resolve(completion(okResult())), {}, { enableThinking: true, thinkingBudget: 1024 })
  await qwen.parser.parse(TRANSCRIPT)
  assert.equal(qwen.calls[0]?.body.enable_thinking, true)
  assert.equal(qwen.calls[0]?.body.thinking_budget, 1024)
  const deepseek = makeParser(() => Promise.resolve(completion(okResult())), {}, { baseUrl: 'https://api.deepseek.com', enableThinking: false, thinkingBudget: 1024 })
  await deepseek.parser.parse(TRANSCRIPT)
  assert.deepEqual(deepseek.calls[0]?.body.thinking, { type: 'disabled' })
  assert.equal(deepseek.calls[0]?.body.thinking_budget, undefined)
})

test('ignores invalid JSON and schemas without retrying semantic refusals', async () => {
  for (const content of ['', '不是JSON', JSON.stringify({ speaker: 'unknown', callsign: 'BD5XXX' }), okResult({ risk: { level: 6, reason: 'r' } }), okResult({ extra: true })]) {
    const { calls, parser } = makeParser(() => Promise.resolve(completion(content)))
    assert.deepEqual(await parser.parse(TRANSCRIPT), {})
    assert.equal(calls.length, 1)
  }
})

test('parses JSON wrapped in a markdown fence', async () => {
  const { parser } = makeParser(() => Promise.resolve(completion(`\`\`\`json\n${okResult()}\n\`\`\``)))
  assert.equal((await parser.parse(TRANSCRIPT))?.callsign, 'BD5XXX')
})

test('retries transport errors independently of semantic rechecking', async () => {
  let attempts = 0
  const { calls, parser } = makeParser(() => Promise.resolve(++attempts === 1 ? new Response('busy', { status: 503 }) : completion(okResult())))
  assert.equal((await parser.parse(TRANSCRIPT))?.callsign, 'BD5XXX')
  assert.equal(calls.length, 2)
})

test('uses the shared schema with callsign-only analysis disabled', async () => {
  const { parser } = makeParser(() => Promise.resolve(completion(okResult())), { analysisEnabled: false })
  assert.deepEqual(await parser.parse(TRANSCRIPT), { callsign: 'BD5XXX' })
})

test('skips missing prompt or schema files', async () => {
  const { calls, parser } = makeParser(() => Promise.resolve(completion(okResult())), { promptFile: '/missing/prompt.txt', schemaFile: '/missing/schema.json' })
  assert.equal(await parser.parse(TRANSCRIPT), undefined)
  assert.equal(calls.length, 0)
})

test('hot-reloads prompt and schema files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iaxweb-reload-'))
  try {
    const promptFile = join(dir, 'prompt.txt')
    const schemaFile = join(dir, 'schema.json')
    writeFileSync(promptFile, combinedPrompts('第一版JSON'))
    writeFileSync(schemaFile, JSON.stringify(modelSchema))
    const { calls, parser } = makeParser(() => Promise.resolve(completion(okResult())), { promptFile, schemaFile })
    assert.equal((await parser.parse(TRANSCRIPT))?.callsign, 'BD5XXX')
    writeFileSync(promptFile, combinedPrompts('第二版JSON'))
    writeFileSync(schemaFile, JSON.stringify({ type: 'object', required: ['qth'], properties: { qth: { type: 'string' } } }))
    assert.deepEqual(await parser.parse(TRANSCRIPT), {})
    assert.ok(calls[1]?.body.messages[0]?.content.includes('第二版JSON'))
  }
  finally { rmSync(dir, { force: true, recursive: true }) }
})

test('validates mutually exclusive self and reject schema branches', () => {
  assert.equal(validateAgainstSchema({ speaker: 'other' }, modelSchema), undefined)
  assert.equal(validateAgainstSchema({ speaker: 'unknown' }, modelSchema), undefined)
  assert.equal(validateAgainstSchema(JSON.parse(okResult()), modelSchema), undefined)
  for (const value of [{}, { speaker: 'self' }, { speaker: 'unknown', callsign: 'BG5ATV' }, { speaker: 'other', extra: true }])
    assert.ok(validateAgainstSchema(value, modelSchema))
  assert.ok(validateAgainstSchema(JSON.parse(okResult({ quote: '' })), modelSchema))
  assert.ok(validateAgainstSchema(JSON.parse(okResult({ callsign: 'BG55ATV' })), modelSchema))
})
