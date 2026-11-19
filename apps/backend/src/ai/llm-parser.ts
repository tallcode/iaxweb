import type { SpeakerMatch } from '@iaxweb/contracts'
import type { CallsignContext, TranscriptTurn } from './callsign-evidence.js'
import type { CallsignModelOutput, TranscriptAnalysis } from './callsign-model-output.js'
import type { LlmClientOptions } from './llm-client.js'
import type { LlmConfigFilePaths, LoadedSchema } from './llm-config-files.js'
import { buildCallsignContext } from './callsign-evidence.js'
import { readCallsignModelOutput } from './callsign-model-output.js'
import { checkTextCallsignOutput } from './callsign-speaker.js'
import { checkStage2Callsign, prepareStage2 } from './callsign-stage2.js'
import { LlmClient } from './llm-client.js'
import { LlmConfigFiles } from './llm-config-files.js'
import { callsignPayload } from './llm-payload.js'
import { shouldIncludeCallsignCorrection } from './phonetic-corrector.js'

export type { RiskRating } from './callsign-model-output.js'
export { LlmError } from './llm-client.js'
export { validateAgainstSchema } from './schema-validator.js'

export interface ParsedTranscript extends TranscriptAnalysis {
  callsign?: string | undefined
}

export interface LlmParserOptions extends LlmClientOptions, LlmConfigFilePaths {
  analysisEnabled?: boolean
  model: string
  enableThinking?: boolean
  thinkingBudget?: number
}

// LLM 后处理：用对话模型对语音识别文本做结构化解析（完整版含规范化、呼号
// 提取与风控，简化版只提取呼号）。每次调用前读取提示词配置，读取失败则跳过。
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
    const prompts = this.files.loadPrompts()
    if (!prompts)
      return undefined
    const schema = this.files.loadSchema()
    if (!schema)
      return undefined
    const context = transcriptContext(transcript, history, metadata)
    // Candidate evidence replaces the old /B/ shortcut, allowing a verified
    // continuation or history-supported self-introduction to be considered.
    if (context.candidates.length === 0 && !this.options.analysisEnabled)
      return {}
    const output = await this.requestDecision(prompts.stage1, schema, transcriptPayload(context, corrected), true)
    if (!output)
      return {}
    const analysis: TranscriptAnalysis = {}
    if (this.options.analysisEnabled) {
      const { message, risk } = output
      if (message === undefined || risk === undefined)
        return {}
      analysis.message = message
      analysis.risk = risk
    }
    const callsign = checkTextCallsignOutput(output, context)
    return callsign ? { ...analysis, callsign } : analysis
  }

  async parseStage2(
    transcript: string,
    history: readonly TranscriptTurn[],
    corrected: string,
    metadata: Omit<TranscriptTurn, 'text'>,
    matches: readonly Pick<SpeakerMatch, 'callsign' | 'confidence'>[],
  ): Promise<string | undefined> {
    const stage = prepareStage2(transcriptContext(transcript, history, metadata), matches)
    if (!stage)
      return undefined
    const { context, match, review } = stage
    const prompts = this.files.loadPrompts()
    if (!prompts)
      return undefined
    const schema = this.files.loadSchema()
    if (!schema)
      return undefined
    const payload = {
      ...transcriptPayload(context, corrected),
      featureMatches: [match],
      ...(review ? { compactReview: review } : {}),
    }
    const prompt = review ? prompts.stage2Review : prompts.stage2
    const output = await this.requestDecision(prompt, schema, payload)
    return checkStage2Callsign(output, context, match, review)
  }

  private async requestDecision(prompt: string, schema: LoadedSchema, content: unknown, retry = false): Promise<CallsignModelOutput | undefined> {
    const body = this.requestBody(prompt, schema.object, content)
    const result = await (retry ? this.client.requestWithRetry(body) : this.client.requestOnce(body))
    const parsed = normalizeCallsign(parseJsonObject(result))
    if (parsed && !schema.validate(parsed))
      return readCallsignModelOutput(parsed)
  }

  private thinkingParams(): Record<string, unknown> {
    if (this.enableThinking === undefined)
      return {}
    if (this.isDeepSeek)
      return { thinking: { type: this.enableThinking ? 'enabled' : 'disabled' } }
    return { enable_thinking: this.enableThinking }
  }

  private requestBody(prompt: string, schema: Record<string, unknown>, content: unknown) {
    return {
      ...this.thinkingParams(),
      ...(this.thinkingBudget !== undefined && !this.isDeepSeek ? { thinking_budget: this.thinkingBudget } : {}),
      messages: [
        { content: `${prompt}\n\n严格按以下 JSON Schema 输出：\n${JSON.stringify(schema)}`, role: 'system' },
        { content: JSON.stringify(content), role: 'user' },
      ],
      model: this.options.model,
      response_format: { type: 'json_object' },
      temperature: 0.1,
    }
  }
}

function transcriptContext(transcript: string, history: string | readonly TranscriptTurn[] | undefined, metadata: Omit<TranscriptTurn, 'text'>): CallsignContext {
  const turns = typeof history === 'string' ? [{ id: 'history', text: history }] : history ?? []
  return buildCallsignContext({ ...metadata, text: transcript }, turns.filter(turn => turn.id !== metadata.id))
}

function transcriptPayload(context: CallsignContext, corrected: string) {
  return {
    ...callsignPayload(context),
    ...(shouldIncludeCallsignCorrection(context.current.text, corrected) ? { corrected: { text: corrected, purpose: '音素纠错辅助文本，仅供判断，不是独立证据' } } : {}),
  }
}

function normalizeCallsign(parsed: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (parsed && typeof parsed.callsign === 'string')
    return { ...parsed, callsign: parsed.callsign.trim().toUpperCase() }
  return parsed
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
