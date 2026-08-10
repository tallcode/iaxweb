import type { TranscriptionContext } from '../../src/ai/asr-client.js'
import assert from 'node:assert/strict'

import test from 'node:test'
import { AsrClient, AsrError, buildRequestBody, extractAsrText } from '../../src/ai/asr-client.js'

const WAV_BYTES = new Uint8Array([82, 73, 70, 70])

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status: 200,
  })
}

function makeClient(fetchImpl: typeof fetch): { calls: Array<{ init: RequestInit | undefined, url: string }>, client: AsrClient } {
  const calls: Array<{ init: RequestInit | undefined, url: string }> = []
  const client = new AsrClient({
    apiKey: 'test-key',
    baseUrl: 'https://dashscope.example',
    fetchImpl: (url, init) => {
      calls.push({ init, url: String(url) })
      return fetchImpl(url, init)
    },
    model: 'qwen-audio-3.0-asr-flash',
    retryDelaysMs: [0],
  })
  return { calls, client }
}

test('builds the request body with context turns and hotwords', () => {
  const context: TranscriptionContext = {
    background: '背景',
    hotwords: { CQ: 5 },
    previous: '上次结果',
  }
  const body = buildRequestBody('model-x', WAV_BYTES, context)

  assert.equal(body.model, 'model-x')
  const messages = (body.input as { messages: Array<Record<string, unknown>> }).messages
  assert.equal(messages.length, 3)
  assert.equal(messages[0]?.role, 'user')
  assert.deepEqual(messages[0]?.content, [{ text: '背景' }])
  assert.equal(messages[1]?.role, 'assistant')
  assert.deepEqual(messages[1]?.content, [{ text: '上次结果' }])
  // The audio message must be last.
  assert.equal(messages[2]?.role, 'user')
  const audio = (messages[2]?.content as Array<Record<string, string>>)[0]?.audio
  assert.ok(audio?.startsWith('data:audio/wav;base64,'))

  const parameters = body.parameters as Record<string, unknown>
  assert.equal(parameters.format, 'wav')
  assert.equal(parameters.sample_rate, '8000')
  assert.deepEqual(parameters.vocabulary, { CQ: 5 })
})

test('omits empty context turns and hotwords', () => {
  const body = buildRequestBody('model-x', WAV_BYTES, {})
  const messages = (body.input as { messages: Array<Record<string, unknown>> }).messages
  assert.equal(messages.length, 1)
  assert.equal(messages[0]?.role, 'user')
  const parameters = body.parameters as Record<string, unknown>
  assert.equal(parameters.vocabulary, undefined)
})

test('extracts text from known response shapes', () => {
  assert.equal(extractAsrText({ output: { text: '甲' } }), '甲')
  assert.equal(extractAsrText({ output: { sentence: { text: '乙' } } }), '乙')
  assert.equal(extractAsrText({ output: { output: { sentence: { text: '丙' } } } }), '丙')
  assert.equal(extractAsrText({ output: { choices: [{ message: { content: '丁' } }] } }), '丁')
  assert.equal(extractAsrText({ output: {} }), undefined)
  assert.equal(extractAsrText({}), undefined)
  assert.equal(extractAsrText(null), undefined)
})

test('transcribes a segment', async () => {
  const { calls, client } = makeClient(() => Promise.resolve(okResponse({ output: { text: 'BG5XXX 签到' } })))
  const text = await client.transcribe(WAV_BYTES, { background: '背景' })

  assert.equal(text, 'BG5XXX 签到')
  assert.equal(calls.length, 1)
  const call = calls[0]
  assert.ok(call)
  assert.equal(call.url, 'https://dashscope.example/api/v1/services/aigc/multimodal-generation/generation')
  assert.equal(call.init?.method, 'POST')
  const headers = call.init?.headers as Record<string, string>
  assert.equal(headers.authorization, 'Bearer test-key')
})

test('retries on server errors and succeeds', async () => {
  let attempt = 0
  const { calls, client } = makeClient(() => {
    attempt++
    if (attempt === 1)
      return Promise.resolve(new Response(JSON.stringify({ message: 'busy' }), { status: 503 }))
    return Promise.resolve(okResponse({ output: { text: '成功' } }))
  })

  assert.equal(await client.transcribe(WAV_BYTES), '成功')
  assert.equal(calls.length, 2)
})

test('retries on network failures', async () => {
  let attempt = 0
  const { calls, client } = makeClient(() => {
    attempt++
    if (attempt === 1)
      return Promise.reject(new TypeError('fetch failed'))
    return Promise.resolve(okResponse({ output: { text: '恢复' } }))
  })

  assert.equal(await client.transcribe(WAV_BYTES), '恢复')
  assert.equal(calls.length, 2)
})

test('does not retry client errors', async () => {
  const { calls, client } = makeClient(() => Promise.resolve(new Response(JSON.stringify({ code: 'InvalidApiKey', message: 'bad key' }), { status: 401 })))

  await assert.rejects(
    client.transcribe(WAV_BYTES),
    (error: unknown) => error instanceof AsrError && error.status === 401 && /bad key/.test(error.message),
  )
  assert.equal(calls.length, 1)
})

test('throws when the response has no text', async () => {
  const { client } = makeClient(() => Promise.resolve(okResponse({ output: {} })))
  await assert.rejects(client.transcribe(WAV_BYTES), /没有识别文本/)
})
