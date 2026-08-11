import { dirname, isAbsolute, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export interface Config {
  allmon3: {
    baseUrl: string
    refreshIntervalMs: number
    requestTimeoutMs: number
  }
  host: string
  port: number
  nats: {
    servers: string[]
    subjectRoot: string
    username?: string
    password?: string
    token?: string
  }
}

const invalidSubjectToken = /[\s*>]/

// The DashScope synchronous ASR endpoint accepts at most 5 minutes of audio per
// request; keep segments safely below that ceiling.
const maxAllowedSegmentMs = 290_000

export interface AiConfig {
  activityWindowMs: number
  apiKey?: string
  backgroundFile: string
  baseUrl: string
  callsignHintsEnabled: boolean
  callsignsFile: string
  coldMinSegmentMs: number
  contextWindowMs: number
  hotMinSegmentMs: number
  hotwordsFile: string
  llmEnabled: boolean
  llmEnableThinking: boolean
  llmModel: string
  llmPromptFile: string
  llmPublishSpot: boolean
  llmSchemaFile: string
  llmThinkingBudget?: number | undefined
  llmTimeoutMs: number
  maxSegmentMs: number
  model: string
}

function optional(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim()
  return value || undefined
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const portText = optional(env, 'PORT') ?? '3000'
  const port = Number(portText)
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error(`PORT must be an integer between 1 and 65535, got: ${portText}`)

  const servers = (optional(env, 'NATS_SERVERS') ?? 'nats://127.0.0.1:4222')
    .split(',')
    .map(server => server.trim())
    .filter(Boolean)
  if (servers.length === 0)
    throw new Error('NATS_SERVERS must contain at least one server URL')

  const legacySubjectPrefix = optional(env, 'NATS_SUBJECT_PREFIX')
  const configuredSubjectRoot = optional(env, 'NATS_SUBJECT_ROOT')
  if (legacySubjectPrefix)
    throw new Error('NATS_SUBJECT_PREFIX is no longer supported; set NATS_SUBJECT_ROOT and remove NATS_SUBJECT_PREFIX')

  const subjectRoot = configuredSubjectRoot ?? 'iaxmon.nodes'
  if (subjectRoot.startsWith('.') || subjectRoot.endsWith('.') || subjectRoot.includes('..') || invalidSubjectToken.test(subjectRoot))
    throw new Error('NATS_SUBJECT_ROOT is not a valid subject root')

  const username = optional(env, 'NATS_USERNAME')
  const password = optional(env, 'NATS_PASSWORD')
  const token = optional(env, 'NATS_TOKEN')

  if (Boolean(username) !== Boolean(password))
    throw new Error('NATS_USERNAME and NATS_PASSWORD must be set together')
  if (token && username)
    throw new Error('NATS_TOKEN cannot be combined with NATS_USERNAME/NATS_PASSWORD')

  const allmon3BaseUrl = optional(env, 'ALLMON3_BASE_URL') ?? 'http://172.16.211.199/allmon3/'
  const parsedAllmon3Url = new URL(allmon3BaseUrl)
  if (!['http:', 'https:'].includes(parsedAllmon3Url.protocol))
    throw new Error('ALLMON3_BASE_URL must use http or https')
  if (!parsedAllmon3Url.pathname.endsWith('/'))
    parsedAllmon3Url.pathname += '/'

  const refreshIntervalMs = parsePositiveInteger(
    optional(env, 'ALLMON3_REFRESH_INTERVAL_MS') ?? '30000',
    'ALLMON3_REFRESH_INTERVAL_MS',
  )
  const requestTimeoutMs = parsePositiveInteger(
    optional(env, 'ALLMON3_REQUEST_TIMEOUT_MS') ?? '10000',
    'ALLMON3_REQUEST_TIMEOUT_MS',
  )

  return {
    allmon3: {
      baseUrl: parsedAllmon3Url.toString(),
      refreshIntervalMs,
      requestTimeoutMs,
    },
    host: optional(env, 'HOST') ?? '0.0.0.0',
    port,
    nats: {
      servers,
      subjectRoot,
      ...(username && password ? { username, password } : {}),
      ...(token ? { token } : {}),
    },
  }
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`${name} must be a positive integer, got: ${value}`)
  return parsed
}

// AI settings are always parsed so invalid values fail fast even when no node
// enables AI; the API key requirement is enforced where node definitions are
// known (see server.ts).
export function loadAiConfig(env: NodeJS.ProcessEnv = process.env): AiConfig {
  const apiKey = optional(env, 'DASHSCOPE_API_KEY')

  const baseUrlText = optional(env, 'DASHSCOPE_BASE_URL') ?? 'https://dashscope.aliyuncs.com'
  const baseUrl = new URL(baseUrlText)
  if (!['http:', 'https:'].includes(baseUrl.protocol))
    throw new Error('DASHSCOPE_BASE_URL must use http or https')

  const model = optional(env, 'AI_ASR_MODEL') ?? 'qwen-audio-3.0-asr-flash'

  const coldMinSegmentMs = parsePositiveInteger(
    optional(env, 'AI_COLD_MIN_SEGMENT_MS') ?? '5000',
    'AI_COLD_MIN_SEGMENT_MS',
  )
  const hotMinSegmentMs = parsePositiveInteger(
    optional(env, 'AI_HOT_MIN_SEGMENT_MS') ?? '2000',
    'AI_HOT_MIN_SEGMENT_MS',
  )
  const maxSegmentMs = parsePositiveInteger(
    optional(env, 'AI_MAX_SEGMENT_MS') ?? '120000',
    'AI_MAX_SEGMENT_MS',
  )
  if (maxSegmentMs <= Math.min(coldMinSegmentMs, hotMinSegmentMs))
    throw new Error('AI_MAX_SEGMENT_MS must be greater than the minimum segment lengths')
  if (maxSegmentMs > maxAllowedSegmentMs)
    throw new Error(`AI_MAX_SEGMENT_MS must not exceed ${maxAllowedSegmentMs} (DashScope 5 minute limit)`)

  const activityWindowMs = parsePositiveInteger(
    optional(env, 'AI_ACTIVITY_WINDOW_MS') ?? '30000',
    'AI_ACTIVITY_WINDOW_MS',
  )

  const contextWindowMs = parsePositiveInteger(
    optional(env, 'AI_CONTEXT_WINDOW_MS') ?? '300000',
    'AI_CONTEXT_WINDOW_MS',
  )

  const llmEnabledText = optional(env, 'AI_LLM_ENABLED') ?? 'true'
  if (llmEnabledText !== 'true' && llmEnabledText !== 'false')
    throw new Error('AI_LLM_ENABLED must be "true" or "false"')
  const llmModel = optional(env, 'AI_LLM_MODEL') ?? 'qwen3.7-flash'

  const callsignHintsEnabledText = optional(env, 'AI_CALLSIGN_HINTS_ENABLED') ?? 'false'
  if (callsignHintsEnabledText !== 'true' && callsignHintsEnabledText !== 'false')
    throw new Error('AI_CALLSIGN_HINTS_ENABLED must be "true" or "false"')

  const llmPublishSpotText = optional(env, 'AI_LLM_PUBLISH_SPOT') ?? 'true'
  if (llmPublishSpotText !== 'true' && llmPublishSpotText !== 'false')
    throw new Error('AI_LLM_PUBLISH_SPOT must be "true" or "false"')

  const llmEnableThinkingText = optional(env, 'AI_LLM_ENABLE_THINKING') ?? 'false'
  if (llmEnableThinkingText !== 'true' && llmEnableThinkingText !== 'false')
    throw new Error('AI_LLM_ENABLE_THINKING must be "true" or "false"')
  const llmThinkingBudgetText = optional(env, 'AI_LLM_THINKING_BUDGET')
  const llmThinkingBudget = llmThinkingBudgetText !== undefined
    ? parsePositiveInteger(llmThinkingBudgetText, 'AI_LLM_THINKING_BUDGET')
    : undefined
  const llmTimeoutMs = parsePositiveInteger(
    optional(env, 'AI_LLM_TIMEOUT_MS') ?? '30000',
    'AI_LLM_TIMEOUT_MS',
  )

  return {
    ...(apiKey ? { apiKey } : {}),
    activityWindowMs,
    backgroundFile: resolveProjectPath(optional(env, 'AI_BACKGROUND_FILE') ?? 'ai/background.txt'),
    baseUrl: baseUrl.toString().replace(/\/+$/, ''),
    callsignHintsEnabled: callsignHintsEnabledText === 'true',
    callsignsFile: resolveProjectPath(optional(env, 'AI_CALLSIGNS_FILE') ?? 'ai/callsigns.txt'),
    coldMinSegmentMs,
    contextWindowMs,
    hotMinSegmentMs,
    hotwordsFile: resolveProjectPath(optional(env, 'AI_HOTWORDS_FILE') ?? 'ai/hotwords.json'),
    llmEnabled: llmEnabledText === 'true',
    llmEnableThinking: llmEnableThinkingText === 'true',
    llmModel,
    llmPromptFile: resolveProjectPath(optional(env, 'AI_LLM_PROMPT_FILE') ?? 'ai/prompt.txt'),
    llmPublishSpot: llmPublishSpotText === 'true',
    llmSchemaFile: resolveProjectPath(optional(env, 'AI_LLM_SCHEMA_FILE') ?? 'ai/schema.json'),
    ...(llmThinkingBudget !== undefined ? { llmThinkingBudget } : {}),
    llmTimeoutMs,
    maxSegmentMs,
    model,
  }
}

function resolveProjectPath(value: string): string {
  if (isAbsolute(value))
    return value
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', value)
}
