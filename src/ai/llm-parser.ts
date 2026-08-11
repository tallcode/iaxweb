import { readFileSync } from 'node:fs'
import { logTimestamp } from './context-store.js'

export interface RiskRating {
  level: number
  reason: string
}

export interface ParsedTranscript {
  Callsign?: string | undefined
  message?: string | undefined
  risk?: RiskRating | undefined
}

export interface LlmParserOptions {
  apiKey: string
  baseUrl: string
  model: string
  promptFile: string
  schemaFile: string
  enableThinking?: boolean
  fetchImpl?: typeof fetch
  retryDelaysMs?: number[]
  thinkingBudget?: number
  timeoutMs?: number
}

const CHAT_PATH = '/compatible-mode/v1/chat/completions'
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_RETRY_DELAYS_MS = [1_000]

// LLM 后处理：用对话模型对语音识别文本做结构化解析（完整版含规范化、呼号
// 提取与风控，简化版只提取呼号）。提示词与 JSON Schema 存在文件中，每次
// 调用前重新读取（同热词）；任一文件缺失则跳过解析，等同 AI_LLM_ENABLED=false。
export class LlmParser {
  private readonly options: LlmParserOptions
  private readonly url: string
  private readonly fetchImpl: typeof fetch
  private readonly retryDelaysMs: number[]
  private readonly timeoutMs: number
  private readonly enableThinking: boolean
  private readonly thinkingBudget: number | undefined
  private lastPrompt: string | undefined
  private lastSchema: { object: Record<string, unknown>, raw: string } | undefined

  constructor(options: LlmParserOptions) {
    this.options = options
    this.url = `${options.baseUrl}${CHAT_PATH}`
    this.fetchImpl = options.fetchImpl ?? fetch
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    // Qwen3 models think by default; normalization/classification does not
    // need it and thinking regularly blew the non-streaming timeout.
    this.enableThinking = options.enableThinking ?? false
    this.thinkingBudget = options.thinkingBudget
  }

  async parse(transcript: string, history?: string): Promise<ParsedTranscript | undefined> {
    // 跑测试前注释掉下面这一行（极端省钱开关，测试输入通常不含 B/布）
    if (!/B|F|布/i.test(transcript)) return {}
    const prompt = this.loadPrompt()
    const schema = this.loadSchema()
    if (!prompt || !schema)
      return undefined
    // Recent turns (if any) give the model conversation continuity; the
    // current transcript is clearly delimited so it is not confused with them.
    const userContent = history
      ? `最近对话历史（按时间顺序）：\n${history}\n\n当前语音识别文本：\n${transcript}`
      : transcript
    const body = {
      enable_thinking: this.enableThinking,
      ...(this.thinkingBudget !== undefined ? { thinking_budget: this.thinkingBudget } : {}),
      messages: [
        { content: `${prompt}\n\n严格按以下 JSON Schema 输出：\n${schema.raw}`, role: 'system' },
        { content: userContent, role: 'user' },
      ],
      model: this.options.model,
      response_format: {
        json_schema: { name: 'transcript-analysis', schema: schema.object },
        type: 'json_schema',
      },
      temperature: 0.1,
    }

    const content = await this.requestWithRetry(body)
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    }
    catch {
      throw new Error(`LLM 返回的不是有效 JSON: ${content.slice(0, 200)}`)
    }

    const error = validateAgainstSchema(parsed, schema.object)
    if (error)
      throw new Error(`LLM 输出不符合 schema: ${error}`)
    return parsed as ParsedTranscript
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

// Validates the subset of JSON Schema the LLM parser output uses: object
// types with properties/required/additionalProperties, and string/boolean/
// number/integer leaves. Returns the first problem found, or undefined.
export function validateAgainstSchema(value: unknown, schema: unknown, path = '$'): string | undefined {
  if (typeof schema !== 'object' || schema === null)
    return undefined
  const spec = schema as Record<string, unknown>

  if (spec.type === 'string') {
    if (typeof value !== 'string')
      return `${path} 应为字符串`
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
    if (typeof value !== 'number' || (spec.type === 'integer' && !Number.isInteger(value)))
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
