import type { CallsignContext, TranscriptTurn } from './callsign-evidence.js'
import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { logTimestamp } from './asr-context-files.js'
import { buildCallsignContext } from './callsign-evidence.js'
import { CallsignHintMatcher, formatCallsignHints } from './callsign-hints.js'
import { checkCallsignDecision, supportedSelfEvidence } from './callsign-speaker.js'
import { shouldIncludeCallsignCorrection } from './phonetic-corrector.js'

export interface RiskRating {
  level: number
  reason: string
}

export interface ParsedTranscript {
  callsign?: string | undefined
  message?: string | undefined
  risk?: RiskRating | undefined
}

export interface LlmParserOptions {
  apiKey: string
  baseUrl: string
  callsignHintsEnabled?: boolean
  callsignsFile?: string
  model: string
  promptFile: string
  schemaFile: string
  enableThinking?: boolean
  fetchImpl?: typeof fetch
  retryDelaysMs?: number[]
  thinkingBudget?: number
  timeoutMs?: number
}

const CHAT_PATH = '/chat/completions'
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_RETRY_DELAYS_MS = [1_000]
// Keep off while observing the first deployment. This is deliberately a code
// switch, not an environment/configuration setting.
const CALLSIGN_RECHECK_ENABLED = false
const CALLSIGN_OUTPUT_POLICY = `呼号输出协议：严格输出JSON。只提取当前说话人自己的呼号，先找当前自报依据，再匹配字母解释法候选。完整拼读仅证明字符，不能证明身份；被叫、复述确认和第三方不得记到自己。没有解释法候选或身份不明就拒绝，不能靠裸字母、合法格式、数据库相似提示猜测。
接受时输出speaker="self"、当前原文逐字引用quote、全大写呼号值callsign及对应候选id整数evidence；字段名callsign小写，不使用Callsign。拒绝时speaker为other或unknown，不输出callsign、evidence、quote。message/risk等额外任务遵循schema。
当前多个自报片段要全部检查，不停在第一个紧凑形式；完整解释法可以纠正同一自报里的ASR字符错误。历史拼读只支持本轮明确自报的同一呼号。kind=verified-continuation才允许跨段，quote只引用当前后半段，不能拼接历史原文。候选id和呼号必须对应；数据库相似提示不能新增证据候选。`

// LLM 后处理：用对话模型对语音识别文本做结构化解析（完整版含规范化、呼号
// 提取与风控，简化版只提取呼号）。提示词与 JSON Schema 存在文件中，每次
// 调用前重新读取（同热词）；任一文件缺失则跳过解析，等同 AI_LLM_ENABLED=false。
export class LlmParser {
  private readonly options: LlmParserOptions
  private readonly url: string
  private readonly fetchImpl: typeof fetch
  private readonly retryDelaysMs: number[]
  private readonly timeoutMs: number
  private readonly enableThinking: boolean | undefined
  private readonly thinkingBudget: number | undefined
  private readonly isDeepSeek: boolean
  private readonly callsignHints: CallsignHintMatcher | undefined
  private lastPrompt: string | undefined
  private lastSchema: { object: Record<string, unknown>, raw: string } | undefined

  constructor(options: LlmParserOptions) {
    this.options = options
    this.url = `${options.baseUrl}${CHAT_PATH}`
    this.fetchImpl = options.fetchImpl ?? fetch
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    // undefined means "let the provider decide"; Qwen users normally set
    // AI_LLM_ENABLE_THINKING=false because thinking often blows the timeout.
    this.enableThinking = options.enableThinking
    this.thinkingBudget = options.thinkingBudget
    this.isDeepSeek = /(?:^|\.)deepseek\.com$/i.test(new URL(options.baseUrl).hostname)
    this.callsignHints = options.callsignHintsEnabled && options.callsignsFile
      ? new CallsignHintMatcher(options.callsignsFile)
      : undefined
  }

  async parse(
    transcript: string,
    history?: string | readonly TranscriptTurn[],
    corrected: string = transcript,
    metadata: Omit<TranscriptTurn, 'text'> = { id: 'current' },
  ): Promise<ParsedTranscript | undefined> {
    const prompt = this.loadPrompt()
    const schema = this.loadSchema()
    if (!prompt || !schema)
      return undefined
    const turns = typeof history === 'string' ? [{ id: 'history', text: history }] : history ?? []
    const context = buildCallsignContext({ ...metadata, text: transcript }, turns.filter(turn => turn.id !== metadata.id))
    // Candidate evidence replaces the old /B/ shortcut, allowing a verified
    // continuation or history-supported self-introduction to be considered.
    if (context.candidates.length === 0 && !hasAnalysisFields(schema.object))
      return {}
    const callsignHints = formatCallsignHints(this.callsignHints?.match(corrected) ?? [])
    const payload = {
      history: context.history,
      current: context.current,
      candidates: context.candidates,
      ...(shouldIncludeCallsignCorrection(transcript, corrected) ? { corrected: { text: corrected, purpose: '音素纠错辅助文本，仅供判断，不是独立证据' } } : {}),
      ...(callsignHints ? { similarityHints: callsignHints } : {}),
    }
    const body = (content: unknown, recheck = false) => ({
      ...(this.thinkingParams()),
      ...(this.thinkingBudget !== undefined && !this.isDeepSeek ? { thinking_budget: this.thinkingBudget } : {}),
      messages: [
        { content: `${prompt}\n\n${CALLSIGN_OUTPUT_POLICY}${recheck ? '\n这是一次引用校验失败后的单次复核。只从独立核验过当前自报引用的候选中选择，suggestedQuote可直接核对；不确定仍然拒绝。' : ''}\n\n严格按以下 JSON Schema 输出：\n${schema.raw}`, role: 'system' },
        { content: JSON.stringify(content), role: 'user' },
      ],
      model: this.options.model,
      response_format: { type: 'json_object' },
      temperature: 0.1,
    })

    const parsed = normalizeCallsign(parseJsonObject(await this.requestWithRetry(body(payload))))
    if (parsed === undefined)
      return {}
    const schemaError = validateAgainstSchema(parsed, schema.object)
    const analysis = schemaError ? {} : analysisFields(parsed)
    const decision = checkCallsignDecision(parsed, context)
    if (!schemaError && decision.callsign)
      return { ...analysis, callsign: decision.callsign }
    // No evidence, normal refusals and unrelated schema errors never trigger
    // a second call. Even when enabled, invalid self claims get at most one.
    if (!CALLSIGN_RECHECK_ENABLED || parsed.speaker !== 'self' || !decision.error)
      return analysis
    const supported = supportedSelfEvidence(context)
    if (supported.length === 0)
      return analysis
    return this.recheckCallsign(context, supported, body, schema.object, analysis)
  }

  private async recheckCallsign(
    context: CallsignContext,
    candidates: ReturnType<typeof supportedSelfEvidence>,
    body: (content: unknown, recheck?: boolean) => unknown,
    schema: Record<string, unknown>,
    fallback: ParsedTranscript,
  ): Promise<ParsedTranscript> {
    let parsed: Record<string, unknown> | undefined
    try {
      parsed = normalizeCallsign(parseJsonObject(await this.requestOnce(body({ history: context.history, current: context.current, candidates }, true))))
    }
    catch (error) {
      console.warn(`${logTimestamp()} [AI]: 呼号单次复核失败: ${errorMessage(error)}`)
      return fallback
    }
    if (!parsed || validateAgainstSchema(parsed, schema))
      return fallback
    const decision = checkCallsignDecision(parsed, { ...context, candidates })
    return decision.callsign ? { ...analysisFields(parsed), callsign: decision.callsign } : fallback
  }

  private thinkingParams(): Record<string, unknown> {
    if (this.enableThinking === undefined)
      return {}
    if (this.isDeepSeek)
      return { thinking: { type: this.enableThinking ? 'enabled' : 'disabled' } }
    return { enable_thinking: this.enableThinking }
  }

  private loadPrompt(): string | undefined {
    let text: string
    try {
      text = readFileSync(this.options.promptFile, 'utf8').trim()
    }
    catch (error) {
      if (isMissingFile(error)) {
        this.lastPrompt = undefined
        return undefined
      }
      console.warn(`${logTimestamp()} [AI]: 提示词文件读取失败 ${this.options.promptFile}: ${errorMessage(error)}`)
      return this.lastPrompt
    }
    if (!text) {
      this.lastPrompt = undefined
      return undefined
    }
    this.lastPrompt = text
    return text
  }

  private loadSchema(): { object: Record<string, unknown>, raw: string } | undefined {
    let raw: string
    try {
      raw = readFileSync(this.options.schemaFile, 'utf8')
    }
    catch (error) {
      if (isMissingFile(error)) {
        this.lastSchema = undefined
        return undefined
      }
      console.warn(`${logTimestamp()} [AI]: schema 文件读取失败 ${this.options.schemaFile}: ${errorMessage(error)}`)
      return this.lastSchema
    }

    try {
      const object = JSON.parse(raw) as unknown
      if (typeof object === 'object' && object !== null && !Array.isArray(object)) {
        const loaded = { object: object as Record<string, unknown>, raw }
        this.lastSchema = loaded
        return loaded
      }
      console.warn(`${logTimestamp()} [AI]: schema 文件必须是 JSON 对象，沿用上次有效配置`)
    }
    catch (error) {
      // Keep the last good schema so a typo while editing does not disable
      // LLM parsing entirely.
      console.warn(`${logTimestamp()} [AI]: schema 文件解析失败，沿用上次有效配置: ${errorMessage(error)}`)
    }
    return this.lastSchema
  }

  private async requestWithRetry(body: unknown): Promise<string> {
    let lastError: unknown = new Error('LLM request failed')
    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt++) {
      try {
        return await this.requestOnce(body)
      }
      catch (error) {
        lastError = error
        const delay = this.retryDelaysMs[attempt]
        if (delay === undefined || !isRetryable(error))
          break
        await sleep(delay)
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  private async requestOnce(body: unknown): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let response: Response
    try {
      response = await this.fetchImpl(this.url, {
        body: JSON.stringify(body),
        headers: {
          'authorization': `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
        },
        method: 'POST',
        signal: controller.signal,
      })
    }
    catch (error) {
      clearTimeout(timer)
      throw new LlmError(`网络错误: ${errorMessage(error)}`)
    }

    let text: string
    try {
      text = await response.text()
    }
    finally {
      clearTimeout(timer)
    }

    if (!response.ok)
      throw new LlmError(`HTTP ${response.status}: ${text.slice(0, 200)}`, response.status)

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    }
    catch {
      throw new LlmError(`响应不是有效 JSON: ${text.slice(0, 200)}`)
    }

    const choices = (parsed as { choices?: Array<{ message?: { content?: unknown } }> }).choices
    const content = choices?.[0]?.message?.content
    if (typeof content !== 'string')
      throw new LlmError(`响应中没有文本: ${text.slice(0, 200)}`)
    return content
  }
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'LlmError'
  }
}

function normalizeCallsign(parsed: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (parsed && typeof parsed.callsign === 'string')
    return { ...parsed, callsign: parsed.callsign.trim().toUpperCase() }
  return parsed
}

function analysisFields(parsed: Record<string, unknown>): ParsedTranscript {
  const result: ParsedTranscript = {}
  if (typeof parsed.message === 'string')
    result.message = parsed.message
  const risk = parsed.risk
  if (typeof risk === 'object' && risk !== null && 'level' in risk && 'reason' in risk
    && Number.isInteger(risk.level) && typeof risk.level === 'number' && risk.level >= 1 && risk.level <= 5 && typeof risk.reason === 'string') {
    result.risk = { level: risk.level, reason: risk.reason }
  }
  return result
}

function hasAnalysisFields(schema: Record<string, unknown>): boolean {
  const properties = schema.properties
  if (typeof properties === 'object' && properties !== null && ('message' in properties || 'risk' in properties))
    return true
  return Array.isArray(schema.oneOf) && schema.oneOf.some(branch => typeof branch === 'object' && branch !== null && hasAnalysisFields(branch as Record<string, unknown>))
}

function parseJsonObject(content: string): Record<string, unknown> | undefined {
  const trimmed = content.trim()
  if (!trimmed)
    return undefined
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const candidates = [unfenced]
  const start = unfenced.indexOf('{')
  const end = unfenced.lastIndexOf('}')
  if (start !== -1 && end > start)
    candidates.push(unfenced.slice(start, end + 1))
  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate)
      if (typeof value === 'object' && value !== null && !Array.isArray(value))
        return value as Record<string, unknown>
    }
    catch {
      continue
    }
  }
  return undefined
}

// Validates the output schema, including the mutually exclusive self/reject
// branches. Returns the first problem found, or undefined.
export function validateAgainstSchema(value: unknown, schema: unknown, path = '$'): string | undefined {
  if (typeof schema !== 'object' || schema === null)
    return undefined
  const spec = schema as Record<string, unknown>

  if (Array.isArray(spec.oneOf) && spec.oneOf.filter(branch => validateAgainstSchema(value, branch, path) === undefined).length !== 1)
    return `${path} 必须恰好匹配 oneOf 的一个分支`
  if ('const' in spec && !isDeepStrictEqual(value, spec.const))
    return `${path} 不匹配固定值`
  if (Array.isArray(spec.enum) && !spec.enum.some(item => isDeepStrictEqual(value, item)))
    return `${path} 不在允许值中`

  if (spec.type === 'string') {
    if (typeof value !== 'string')
      return `${path} 应为字符串`
    if (typeof spec.minLength === 'number' && value.length < spec.minLength)
      return `${path} 字符串过短`
    if (typeof spec.pattern === 'string') {
      let pattern: RegExp
      try {
        pattern = new RegExp(spec.pattern)
      }
      catch {
        return `${path} 的 schema pattern 无效`
      }
      if (!pattern.test(value))
        return `${path} 不匹配格式 ${spec.pattern}`
    }
    return undefined
  }
  if (spec.type === 'boolean') {
    if (typeof value !== 'boolean')
      return `${path} 应为布尔值`
    return undefined
  }
  if (spec.type === 'number' || spec.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (spec.type === 'integer' && !Number.isInteger(value)))
      return `${path} 应为${spec.type === 'integer' ? '整数' : '数字'}`
    if (typeof spec.minimum === 'number' && value < spec.minimum)
      return `${path} 不能小于 ${spec.minimum}`
    if (typeof spec.maximum === 'number' && value > spec.maximum)
      return `${path} 不能大于 ${spec.maximum}`
    return undefined
  }
  if (spec.type !== 'object')
    return undefined // unsupported type keyword: nothing to enforce

  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return `${path} 应为对象`

  const record = value as Record<string, unknown>
  const properties = spec.properties as Record<string, unknown> | undefined
  for (const required of (spec.required ?? []) as string[]) {
    if (!(required in record))
      return `${path} 缺少必需字段 "${required}"`
  }
  for (const [key, child] of Object.entries(record)) {
    const childSchema = properties?.[key]
    if (childSchema === undefined) {
      if (spec.additionalProperties === false)
        return `${path} 包含未定义的字段 "${key}"`
      continue
    }
    const childError = validateAgainstSchema(child, childSchema, `${path}.${key}`)
    if (childError)
      return childError
  }
  return undefined
}

function isRetryable(error: unknown): boolean {
  if (!(error instanceof LlmError))
    return false
  if (error.status === undefined)
    return true
  return error.status === 429 || error.status >= 500
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sleep(ms: number): Promise<void> {
  return new Promise(done => setTimeout(done, ms))
}
