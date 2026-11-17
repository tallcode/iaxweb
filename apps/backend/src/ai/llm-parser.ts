import type { CallsignContext, TranscriptTurn } from './callsign-evidence.js'
import type { LlmClientOptions } from './llm-client.js'
import { logTimestamp } from './asr-context-files.js'
import { buildCallsignContext } from './callsign-evidence.js'
import { checkCallsignDecision, supportedSelfEvidence } from './callsign-speaker.js'
import { LlmClient } from './llm-client.js'
import { LlmConfigFiles } from './llm-config-files.js'
import { callsignPayload } from './llm-payload.js'
import { shouldIncludeCallsignCorrection } from './phonetic-corrector.js'
import { validateAgainstSchema } from './schema-validator.js'

export { LlmError } from './llm-client.js'
export { validateAgainstSchema } from './schema-validator.js'

export interface RiskRating {
  level: number
  reason: string
}

export interface ParsedTranscript {
  callsign?: string | undefined
  message?: string | undefined
  risk?: RiskRating | undefined
}

export interface LlmParserOptions extends LlmClientOptions {
  model: string
  promptFile: string
  schemaFile: string
  enableThinking?: boolean
  thinkingBudget?: number
}

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
  private readonly enableThinking: boolean | undefined
  private readonly thinkingBudget: number | undefined
  private readonly isDeepSeek: boolean
  private readonly client: LlmClient
  private readonly files: LlmConfigFiles

  constructor(options: LlmParserOptions) {
    this.options = options
    this.client = new LlmClient(options)
    this.files = new LlmConfigFiles(options)
    // undefined means "let the provider decide"; Qwen users normally set
    // AI_LLM_ENABLE_THINKING=false because thinking often blows the timeout.
    this.enableThinking = options.enableThinking
    this.thinkingBudget = options.thinkingBudget
    this.isDeepSeek = /(?:^|\.)deepseek\.com$/i.test(new URL(options.baseUrl).hostname)
  }

  async parse(
    transcript: string,
    history?: string | readonly TranscriptTurn[],
    corrected: string = transcript,
    metadata: Omit<TranscriptTurn, 'text'> = { id: 'current' },
  ): Promise<ParsedTranscript | undefined> {
    const prompt = this.files.loadPrompt()
    const schema = this.files.loadSchema()
    if (!prompt || !schema)
      return undefined
    const turns = typeof history === 'string' ? [{ id: 'history', text: history }] : history ?? []
    const context = buildCallsignContext({ ...metadata, text: transcript }, turns.filter(turn => turn.id !== metadata.id))
    // Candidate evidence replaces the old /B/ shortcut, allowing a verified
    // continuation or history-supported self-introduction to be considered.
    if (context.candidates.length === 0 && !hasAnalysisFields(schema.object))
      return {}
    const payload = {
      ...callsignPayload(context),
      ...(shouldIncludeCallsignCorrection(transcript, corrected) ? { corrected: { text: corrected, purpose: '音素纠错辅助文本，仅供判断，不是独立证据' } } : {}),
    }
    const body = (content: unknown, recheck = false) => ({
      ...(this.thinkingParams()),
      ...(this.thinkingBudget !== undefined && !this.isDeepSeek ? { thinking_budget: this.thinkingBudget } : {}),
      messages: [
        { content: `${prompt}\n\n${CALLSIGN_OUTPUT_POLICY}${recheck ? '\n这是一次引用校验失败后的单次复核。只从独立核验过当前自报引用的候选中选择，suggestedQuote可直接核对；不确定仍然拒绝。' : ''}\n\n严格按以下 JSON Schema 输出：\n${JSON.stringify(schema.object)}`, role: 'system' },
        { content: JSON.stringify(content), role: 'user' },
      ],
      model: this.options.model,
      response_format: { type: 'json_object' },
      temperature: 0.1,
    })

    const parsed = normalizeCallsign(parseJsonObject(await this.client.requestWithRetry(body(payload))))
    if (parsed === undefined)
      return {}
    const schemaError = schema.validate(parsed)
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
      parsed = normalizeCallsign(parseJsonObject(await this.client.requestOnce(body(callsignPayload(context, candidates), true))))
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
