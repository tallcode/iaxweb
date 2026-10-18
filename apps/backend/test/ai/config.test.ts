import assert from 'node:assert/strict'
import test from 'node:test'

import { loadAiConfig } from '../../src/config.js'

test('loads AI defaults', () => {
  const config = loadAiConfig({})
  assert.equal(config.asr.apiKey, undefined)
  assert.equal(config.asr.baseUrl, 'https://dashscope.aliyuncs.com')
  assert.equal(config.asr.model, 'qwen-audio-3.1-asr-flash')
  assert.equal(config.llm.apiKey, undefined)
  assert.equal(config.llm.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1')
  assert.equal(config.llm.model, 'qwen3.7-flash')
  assert.equal(config.coldMinSegmentMs, 5_000)
  assert.equal(config.hotMinSegmentMs, 2_000)
  assert.equal(config.activityWindowMs, 30_000)
  assert.equal(config.maxSegmentMs, 120_000)
  assert.equal(config.contextWindowMs, 300_000)
  assert.ok(config.databaseFile.endsWith('data/ai.sqlite'))
  assert.ok(config.recordingsDirectory.endsWith('data/rec'))
  assert.ok(config.adminFile.endsWith('config/admin.json'))
  assert.ok(config.sessionsFile.endsWith('data/sessions.json'))
  assert.equal(config.llm.enabled, true)
  assert.equal(config.persistenceEnabled, false)
  assert.equal(config.llm.enableThinking, false)
  assert.equal(config.llm.timeoutMs, 30_000)
  assert.equal(config.llm.thinkingBudget, undefined)
  assert.equal(config.llm.publishSpot, true)
  assert.equal(config.callsignHintsEnabled, false)
  assert.ok(config.callsignsFile.endsWith('config/callsigns.txt'))
  assert.ok(config.llm.promptFile.endsWith('config/prompt.txt'))
  assert.ok(config.llm.schemaFile.endsWith('config/schema.json'))
  assert.ok(config.hotwordsFile.endsWith('config/hotwords.json'))
  assert.ok(config.backgroundFile.endsWith('config/background.txt'))
})

test('loads custom AI settings', () => {
  const config = loadAiConfig({
    AI_ASR_API_KEY: 'sk-asr',
    AI_ASR_BASE_URL: 'https://asr.example/',
    AI_ASR_MODEL: 'fun-asr-flash',
    AI_COLD_MIN_SEGMENT_MS: '4000',
    AI_CONTEXT_WINDOW_MS: '60000',
    AI_DATABASE_FILE: '/var/lib/iaxweb/ai.sqlite',
    AI_ADMIN_FILE: '/var/lib/iaxweb/admin.json',
    AI_LLM_API_KEY: 'sk-llm',
    AI_LLM_BASE_URL: 'https://llm.example/v1/',
    AI_LLM_MODEL: 'deepseek-chat',
    AI_RECORDINGS_DIR: '/var/lib/iaxweb/rec',
    AI_SESSIONS_FILE: '/var/lib/iaxweb/sessions.json',
    AI_HOT_MIN_SEGMENT_MS: '1500',
    AI_MAX_SEGMENT_MS: '90000',
  })
  assert.equal(config.asr.apiKey, 'sk-asr')
  assert.equal(config.asr.baseUrl, 'https://asr.example')
  assert.equal(config.asr.model, 'fun-asr-flash')
  assert.equal(config.llm.apiKey, 'sk-llm')
  assert.equal(config.llm.baseUrl, 'https://llm.example/v1')
  assert.equal(config.llm.model, 'deepseek-chat')
  assert.equal(config.llm.enableThinking, undefined)
  assert.equal(config.coldMinSegmentMs, 4_000)
  assert.equal(config.hotMinSegmentMs, 1_500)
  assert.equal(config.maxSegmentMs, 90_000)
  assert.equal(config.contextWindowMs, 60_000)
  assert.equal(config.databaseFile, '/var/lib/iaxweb/ai.sqlite')
  assert.equal(config.adminFile, '/var/lib/iaxweb/admin.json')
  assert.equal(config.recordingsDirectory, '/var/lib/iaxweb/rec')
  assert.equal(config.sessionsFile, '/var/lib/iaxweb/sessions.json')
})

test('keeps ASR and LLM credentials independent', () => {
  const config = loadAiConfig({ AI_ASR_API_KEY: 'sk-asr', AI_LLM_API_KEY: 'sk-llm' })
  assert.equal(config.asr.apiKey, 'sk-asr')
  assert.equal(config.llm.apiKey, 'sk-llm')
})

test('DASHSCOPE_* is only a legacy ASR alias', () => {
  const config = loadAiConfig({
    DASHSCOPE_API_KEY: 'sk-legacy',
    DASHSCOPE_BASE_URL: 'https://legacy.example/',
  })
  assert.equal(config.asr.apiKey, 'sk-legacy')
  assert.equal(config.asr.baseUrl, 'https://legacy.example')
  assert.equal(config.llm.apiKey, undefined)
  assert.equal(config.llm.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1')
})

test('prefers AI_ASR_* over the legacy DASHSCOPE_* alias', () => {
  const config = loadAiConfig({
    AI_ASR_API_KEY: 'sk-new',
    AI_ASR_BASE_URL: 'https://asr.example',
    DASHSCOPE_API_KEY: 'sk-legacy',
    DASHSCOPE_BASE_URL: 'https://legacy.example',
  })
  assert.equal(config.asr.apiKey, 'sk-new')
  assert.equal(config.asr.baseUrl, 'https://asr.example')
})

test('normalizes the ASR base URL', () => {
  const config = loadAiConfig({ AI_ASR_BASE_URL: 'https://dashscope.example/' })
  assert.equal(config.asr.baseUrl, 'https://dashscope.example')
})

test('rejects a non-http ASR base URL', () => {
  assert.throws(
    () => loadAiConfig({ AI_ASR_BASE_URL: 'ftp://dashscope.example' }),
    /AI_ASR_BASE_URL must use http or https/,
  )
})

test('rejects a non-http LLM base URL', () => {
  assert.throws(
    () => loadAiConfig({ AI_LLM_BASE_URL: 'ftp://llm.example' }),
    /AI_LLM_BASE_URL must use http or https/,
  )
})

test('only defaults thinking off for Qwen models', () => {
  assert.equal(loadAiConfig({}).llm.enableThinking, false)
  assert.equal(loadAiConfig({ AI_LLM_ENABLE_THINKING: 'true' }).llm.enableThinking, true)
  assert.equal(loadAiConfig({ AI_LLM_ENABLE_THINKING: 'false' }).llm.enableThinking, false)
  assert.equal(loadAiConfig({ AI_LLM_MODEL: 'deepseek-chat' }).llm.enableThinking, undefined)
})

test('rejects max segment not greater than the minimum segment lengths', () => {
  assert.throws(
    () => loadAiConfig({ AI_MAX_SEGMENT_MS: '2000' }),
    /greater than the minimum segment lengths/,
  )
  assert.throws(
    () => loadAiConfig({ AI_MAX_SEGMENT_MS: '3000' }),
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
  assert.equal(config.llm.enabled, false)
})

test('can disable SQLite and recording persistence', () => {
  const config = loadAiConfig({ AI_PERSISTENCE_ENABLED: 'false' })
  assert.equal(config.persistenceEnabled, false)
})

test('can disable spot publishing', () => {
  const config = loadAiConfig({ AI_LLM_PUBLISH_SPOT: 'false' })
  assert.equal(config.llm.publishSpot, false)
})

test('can enable common callsign hints and override the list path', () => {
  const config = loadAiConfig({
    AI_CALLSIGN_HINTS_ENABLED: 'true',
    AI_CALLSIGNS_FILE: '/custom/callsigns.txt',
  })
  assert.equal(config.callsignHintsEnabled, true)
  assert.equal(config.callsignsFile, '/custom/callsigns.txt')
})

test('rejects an invalid AI_CALLSIGN_HINTS_ENABLED', () => {
  assert.throws(() => loadAiConfig({ AI_CALLSIGN_HINTS_ENABLED: 'yes' }), /true.*false/)
})

test('rejects an invalid AI_LLM_PUBLISH_SPOT', () => {
  assert.throws(() => loadAiConfig({ AI_LLM_PUBLISH_SPOT: 'yes' }), /true.*false/)
})

test('rejects an invalid AI_PERSISTENCE_ENABLED', () => {
  assert.throws(() => loadAiConfig({ AI_PERSISTENCE_ENABLED: 'yes' }), /true.*false/)
})

test('explicit prompt and schema files override the defaults', () => {
  const config = loadAiConfig({
    AI_LLM_PROMPT_FILE: '/custom/prompt.txt',
    AI_LLM_SCHEMA_FILE: '/custom/schema.json',
  })
  assert.ok(config.llm.promptFile.endsWith('custom/prompt.txt'))
  assert.ok(config.llm.schemaFile.endsWith('custom/schema.json'))
})
