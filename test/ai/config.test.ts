import assert from 'node:assert/strict'
import test from 'node:test'

import { loadAiConfig } from '../../src/config.js'

test('loads AI defaults', () => {
  const config = loadAiConfig({})
  assert.equal(config.apiKey, undefined)
  assert.equal(config.baseUrl, 'https://dashscope.aliyuncs.com')
  assert.equal(config.model, 'qwen-audio-3.0-asr-flash')
  assert.equal(config.coldMinSegmentMs, 5_000)
  assert.equal(config.hotMinSegmentMs, 2_000)
  assert.equal(config.activityWindowMs, 30_000)
  assert.equal(config.maxSegmentMs, 120_000)
  assert.equal(config.contextWindowMs, 300_000)
  assert.equal(config.llmEnabled, true)
  assert.equal(config.llmEnableThinking, false)
  assert.equal(config.llmTimeoutMs, 30_000)
  assert.equal(config.llmThinkingBudget, undefined)
  assert.equal(config.llmModel, 'qwen3.7-flash')
  assert.equal(config.llmPublishSpot, true)
  assert.ok(config.llmPromptFile.endsWith('ai/prompt.txt'))
  assert.ok(config.llmSchemaFile.endsWith('ai/schema.json'))
  assert.ok(config.hotwordsFile.endsWith('ai/hotwords.json'))
  assert.ok(config.backgroundFile.endsWith('ai/background.txt'))
})

test('loads custom AI settings', () => {
  const config = loadAiConfig({
    AI_ASR_MODEL: 'fun-asr-flash',
    AI_COLD_MIN_SEGMENT_MS: '4000',
    AI_CONTEXT_WINDOW_MS: '60000',
    AI_HOT_MIN_SEGMENT_MS: '1500',
    AI_MAX_SEGMENT_MS: '90000',
    DASHSCOPE_API_KEY: 'sk-test',
  })
  assert.equal(config.apiKey, 'sk-test')
  assert.equal(config.model, 'fun-asr-flash')
  assert.equal(config.coldMinSegmentMs, 4_000)
  assert.equal(config.hotMinSegmentMs, 1_500)
  assert.equal(config.maxSegmentMs, 90_000)
  assert.equal(config.contextWindowMs, 60_000)
})

test('normalizes the DashScope base URL', () => {
  const config = loadAiConfig({ DASHSCOPE_BASE_URL: 'https://dashscope.example/' })
  assert.equal(config.baseUrl, 'https://dashscope.example')
})

test('rejects a non-http DashScope base URL', () => {
  assert.throws(
    () => loadAiConfig({ DASHSCOPE_BASE_URL: 'ftp://dashscope.example' }),
    /http or https/,
  )
})

test('rejects max segment not greater than the minimum segment lengths', () => {
  assert.throws(
    () => loadAiConfig({ AI_MAX_SEGMENT_MS: '2000' }),
    /greater than the minimum segment lengths/,
  )
})

test('rejects max segment above the DashScope 5 minute limit', () => {
  assert.throws(
    () => loadAiConfig({ AI_MAX_SEGMENT_MS: '300000' }),
    /290000/,
  )
})

test('rejects non-integer segment lengths', () => {
  assert.throws(() => loadAiConfig({ AI_COLD_MIN_SEGMENT_MS: 'abc' }), /positive integer/)
})

test('rejects an invalid AI_LLM_ENABLED', () => {
  assert.throws(() => loadAiConfig({ AI_LLM_ENABLED: 'yes' }), /true.*false/)
})

test('can disable the LLM stage', () => {
  const config = loadAiConfig({ AI_LLM_ENABLED: 'false' })
  assert.equal(config.llmEnabled, false)
})

test('can disable spot publishing', () => {
  const config = loadAiConfig({ AI_LLM_PUBLISH_SPOT: 'false' })
  assert.equal(config.llmPublishSpot, false)
})

test('rejects an invalid AI_LLM_PUBLISH_SPOT', () => {
  assert.throws(() => loadAiConfig({ AI_LLM_PUBLISH_SPOT: 'yes' }), /true.*false/)
})

test('explicit prompt and schema files override the defaults', () => {
  const config = loadAiConfig({
    AI_LLM_PROMPT_FILE: '/custom/prompt.txt',
    AI_LLM_SCHEMA_FILE: '/custom/schema.json',
  })
  assert.ok(config.llmPromptFile.endsWith('custom/prompt.txt'))
  assert.ok(config.llmSchemaFile.endsWith('custom/schema.json'))
})
