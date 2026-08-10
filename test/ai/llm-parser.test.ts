import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { LlmParser, validateAgainstSchema } from '../../src/ai/llm-parser.js'

const fixtureDir = mkdtempSync(join(tmpdir(), 'iaxweb-llm-'))
const fixturePrompt = join(fixtureDir, 'prompt.txt')
const fixtureSchema = join(fixtureDir, 'schema.json')
writeFileSync(fixturePrompt, '测试提示词')
writeFileSync(fixtureSchema, JSON.stringify({
  additionalProperties: false,
  properties: {
    Callsign: { type: 'string' },
    message: { type: 'string' },
    risk: {
      additionalProperties: false,
      properties: {
        level: { maximum: 5, minimum: 1, type: 'integer' },
        reason: { type: 'string' },
      },
      required: ['level', 'reason'],
      type: 'object',
    },
  },
  required: ['message', 'risk'],
  type: 'object',
}))
after(() => rmSync(fixtureDir, { force: true, recursive: true }))

function completion(content: string): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content } }],
  }), {
    headers: { 'content-type': 'application/json' },
    status: 200,
  })
}

function okResult(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    Callsign: 'BD5XXX',
    message: 'BD5XXX 呼叫 CQ，杭州',
    risk: { level: 1, reason: '正常' },
    ...overrides,
  })
}

interface CapturedCall {
  body: {
    enable_thinking?: boolean
    messages: Array<{ content: string, role: string }>
    response_format?: { json_schema?: { schema?: unknown }, type?: string }
    thinking_budget?: number
  }
  url: string
}

function makeParser(
  fetchImpl: typeof fetch,
  files: { promptFile?: string, schemaFile?: string } = {},
  extra: { enableThinking?: boolean, thinkingBudget?: number } = {},
): { calls: CapturedCall[], parser: LlmParser } {
  const calls: CapturedCall[] = []
  const parser = new LlmParser({
    apiKey: 'test-key',
    baseUrl: 'https://dashscope.example',
    ...(extra.enableThinking !== undefined ? { enableThinking: extra.enableThinking } : {}),
    fetchImpl: (url, init) => {
      calls.push({ body: JSON.parse(String(init?.body)), url: String(url) })
      return fetchImpl(url, init)
    },
    model: 'qwen3.7-flash',
    promptFile: files.promptFile ?? fixturePrompt,
    retryDelaysMs: [0],
    schemaFile: files.schemaFile ?? fixtureSchema,
    ...(extra.thinkingBudget !== undefined ? { thinkingBudget: extra.thinkingBudget } : {}),
  })
  return { calls, parser }
}

test('parses a schema-valid model response', async () => {
  const { calls, parser } = makeParser(() => Promise.resolve(completion(okResult())))

  const parsed = await parser.parse('原始文本')
  assert.ok(parsed)
  assert.equal(parsed.message, 'BD5XXX 呼叫 CQ，杭州')
  assert.equal(parsed.Callsign, 'BD5XXX')
  assert.deepEqual(parsed.risk, { level: 1, reason: '正常' })

  const call = calls[0]
  assert.ok(call)
  assert.equal(call.url, 'https://dashscope.example/compatible-mode/v1/chat/completions')
  assert.equal(call.body.messages[0]?.role, 'system')
  assert.equal(call.body.messages[1]?.role, 'user')
  assert.equal(call.body.messages[1]?.content, '原始文本')
  assert.equal(call.body.response_format?.type, 'json_schema')
  assert.equal(call.body.enable_thinking, false)
})

test('passes conversation history to the model', async () => {
  const { calls, parser } = makeParser(() => Promise.resolve(completion(okResult())))

  await parser.parse('当前文本', 'BG5XXX: 上一条消息')
  const user = calls[0]?.body.messages[1]?.content
  assert.ok(user)
  assert.ok(user.includes('最近对话历史'))
  assert.ok(user.includes('BG5XXX: 上一条消息'))
  assert.ok(user.includes('当前语音识别文本：\n当前文本'))
})

test('sends thinking parameters when enabled', async () => {
  const { calls, parser } = makeParser(
    () => Promise.resolve(completion(okResult({ Callsign: undefined }))),
    {},
    { enableThinking: true, thinkingBudget: 1024 },
  )
  await parser.parse('x')
  assert.equal(calls[0]?.body.enable_thinking, true)
  assert.equal(calls[0]?.body.thinking_budget, 1024)
})

test('rejects responses missing required fields', async () => {
  const { parser } = makeParser(() => Promise.resolve(completion(JSON.stringify({ message: '只有文本' }))))
  await assert.rejects(parser.parse('x'), /缺少必需字段 "risk"/)
})

test('rejects responses with wrong field types', async () => {
  const { parser } = makeParser(() => Promise.resolve(
    completion(JSON.stringify({ message: 'x', risk: { level: '高', reason: 'r' } })),
  ))
  await assert.rejects(parser.parse('x'), /risk\.level 应为整数/)
})

test('rejects risk levels outside 1..5', async () => {
  const { parser } = makeParser(() => Promise.resolve(
    completion(JSON.stringify({ message: 'x', risk: { level: 6, reason: 'r' } })),
  ))
  await assert.rejects(parser.parse('x'), /risk\.level 不能大于 5/)
})

test('rejects responses with unexpected fields', async () => {
  const { parser } = makeParser(() => Promise.resolve(
    completion(JSON.stringify({ extra: true, ...JSON.parse(okResult()) })),
  ))
  await assert.rejects(parser.parse('x'), /未定义的字段 "extra"/)
})

test('rejects non-JSON model output', async () => {
  const { parser } = makeParser(() => Promise.resolve(completion('不是 JSON')))
  await assert.rejects(parser.parse('x'), /不是有效 JSON/)
})

test('retries on server errors', async () => {
  let attempt = 0
  const { calls, parser } = makeParser(() => {
    attempt++
    if (attempt === 1)
      return Promise.resolve(new Response('busy', { status: 503 }))
    return Promise.resolve(completion(okResult({ risk: { level: 4, reason: '测试' } })))
  })

  const parsed = await parser.parse('x')
  assert.ok(parsed)
  assert.equal(parsed.risk.level, 4)
  assert.equal(calls.length, 2)
})

test('skips parsing when prompt or schema files are missing', async () => {
  const { calls, parser } = makeParser(() => Promise.resolve(completion(okResult())), {
    promptFile: '/nonexistent/prompt.txt',
    schemaFile: '/nonexistent/schema.json',
  })

  assert.equal(await parser.parse('x'), undefined)
  assert.equal(calls.length, 0)
})

test('hot-reloads prompt and schema files', async (t) => {
  t.mock.method(console, 'warn', () => {})
  const dir = mkdtempSync(join(tmpdir(), 'iaxweb-llm-'))
  try {
    const promptFile = join(dir, 'prompt.txt')
    const schemaFile = join(dir, 'schema.json')
    writeFileSync(promptFile, '第一版提示词')
    writeFileSync(schemaFile, JSON.stringify({
      additionalProperties: false,
      properties: {
        Callsign: { type: 'string' },
        message: { type: 'string' },
        risk: {
          additionalProperties: false,
          properties: {
            level: { maximum: 5, minimum: 1, type: 'integer' },
            reason: { type: 'string' },
          },
          required: ['level', 'reason'],
          type: 'object',
        },
      },
      required: ['message', 'risk'],
      type: 'object',
    }))

    const { calls, parser } = makeParser(() => Promise.resolve(completion(okResult())), { promptFile, schemaFile })
    await parser.parse('x')
    assert.ok(calls[0]?.body.messages[0]?.content.includes('第一版提示词'))

    // Edits apply to the next call without a restart; the edited schema
    // requires a new field, so the same model response now fails validation.
    writeFileSync(promptFile, '第二版提示词')
    writeFileSync(schemaFile, JSON.stringify({
      additionalProperties: false,
      properties: { message: { type: 'string' }, qth: { type: 'string' }, risk: { type: 'object' } },
      required: ['message', 'risk', 'qth'],
      type: 'object',
    }))
    await assert.rejects(parser.parse('x'), /缺少必需字段 "qth"/)
    assert.ok(calls[1]?.body.messages[0]?.content.includes('第二版提示词'))
  }
  finally {
    rmSync(dir, { force: true, recursive: true })
  }
})

test('validateAgainstSchema accepts optional absent properties', () => {
  const risk = {
    additionalProperties: false,
    properties: {
      level: { maximum: 5, minimum: 1, type: 'integer' },
      reason: { type: 'string' },
    },
    required: ['level', 'reason'],
    type: 'object',
  }
  const schema = {
    additionalProperties: false,
    properties: { Callsign: { type: 'string' }, message: { type: 'string' }, risk },
    required: ['message', 'risk'],
    type: 'object',
  }
  assert.equal(validateAgainstSchema({ message: 'x', risk: { level: 1, reason: '正常' } }, schema), undefined)
  assert.equal(validateAgainstSchema({ Callsign: 'BD5XXX', message: 'x', risk: { level: 1, reason: '正常' } }, schema), undefined)
  assert.ok(validateAgainstSchema({ message: 'x', risk: { level: 6, reason: 'r' } }, schema))
  assert.ok(validateAgainstSchema({ message: 'x', risk: { level: 1 } }, schema))
  assert.ok(validateAgainstSchema('text', schema))
  assert.ok(validateAgainstSchema(null, schema))
})
