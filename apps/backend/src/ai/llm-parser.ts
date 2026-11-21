import type { SpeakerMatch } from '@iaxweb/contracts'
import type { TranscriptTurn } from './callsign-evidence.js'
import type { CallsignExtraction } from './callsign-extraction.js'
import type { TranscriptAnalysis } from './callsign-model-output.js'
import type { LlmClientOptions } from './llm-client.js'
import type { LlmConfigFilePaths } from './llm-config-files.js'
import { cleanCallsignExtraction, matchExtractedCallsign, readCallsignExtraction } from './callsign-extraction.js'
import { matchFeatureCallsign } from './callsign-stage2.js'
import { LlmClient } from './llm-client.js'
import { LlmConfigFiles } from './llm-config-files.js'
import { correctExplanationText } from './phonetic-corrector.js'

export type { RiskRating } from './callsign-model-output.js'
export { LlmError } from './llm-client.js'
export { validateAgainstSchema } from './schema-validator.js'

export interface ParsedTranscript extends TranscriptAnalysis {
  callsign?: string | undefined
  extraction?: CallsignExtraction
}

export interface LlmParserOptions extends LlmClientOptions, LlmConfigFilePaths {
  analysisEnabled?: boolean
  model: string
  enableThinking?: boolean
  thinkingBudget?: number
}

const TRIGGER = /[b布补]/i

// One model request extracts identity and spelling; all final matching is code.
// The raw ASR text is preserved. Phonetic correction only opens the entry gate.
export class LlmParser {
  private readonly client: LlmClient
  private readonly files: LlmConfigFiles
  private readonly isDeepSeek: boolean

  constructor(private readonly options: LlmParserOptions) {
    this.client = new LlmClient(options)
    this.files = new LlmConfigFiles(options)
    this.isDeepSeek = /(?:^|\.)deepseek\.com$/i.test(new URL(options.baseUrl).hostname)
  }

  async parse(
    transcript: string,
    history?: string | readonly TranscriptTurn[],
    _corrected: string = transcript,
    metadata: Omit<TranscriptTurn, 'text'> = { id: 'current' },
  ): Promise<ParsedTranscript | undefined> {
    const prompt = this.files.loadPrompt()
    const schema = this.files.loadSchema()
    if (!prompt || !schema)
      return undefined
    if (!TRIGGER.test(transcript) && !TRIGGER.test(correctExplanationText(transcript).text))
      return {}
    const turns = (typeof history === 'string' ? [{ id: 'history', text: history }] : history ?? [])
      .filter(turn => turn.id !== metadata.id)
    const body = {
      ...this.thinkingParams(),
      model: this.options.model,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `${prompt}\n\n严格按以下 JSON Schema 输出\n${JSON.stringify(schema.object)}` },
        { role: 'user', content: JSON.stringify({ history: turns, current: { ...metadata, text: transcript } }) },
      ],
    }
    const raw = parseJsonObject(await this.client.requestWithRetry(body))
    const cleaned = raw && cleanCallsignExtraction(raw, transcript, turns)
    if (!cleaned || schema.validate(cleaned))
      return {}
    const analysis = this.readAnalysis(cleaned)
    if (!analysis)
      return {}
    const extraction = readCallsignExtraction(cleaned)
    const callsign = matchExtractedCallsign(extraction)
    return { ...analysis, extraction, ...(callsign ? { callsign } : {}) }
  }

  // A missing extraction means Stage 1 was skipped or failed. Never re-parse
  // the transcript, reload prompts, or send a second model request here.
  parseStage2(parsed: ParsedTranscript, matches: readonly Pick<SpeakerMatch, 'callsign' | 'confidence'>[]): string | undefined {
    return parsed.extraction ? matchFeatureCallsign(parsed.extraction, matches) : undefined
  }

  private thinkingParams(): Record<string, unknown> {
    const enabled = this.options.enableThinking ?? false
    return {
      ...(this.isDeepSeek ? { thinking: { type: enabled ? 'enabled' : 'disabled' } } : { enable_thinking: enabled }),
      ...(this.options.thinkingBudget !== undefined && !this.isDeepSeek ? { thinking_budget: this.options.thinkingBudget } : {}),
    }
  }

  private readAnalysis(value: Record<string, unknown>): TranscriptAnalysis | undefined {
    if (!this.options.analysisEnabled)
      return {}
    const { message, risk } = value
    if (typeof message !== 'string' || typeof risk !== 'object' || risk === null || Array.isArray(risk))
      return undefined
    const { level, reason } = risk as Record<string, unknown>
    if (typeof level !== 'number' || !Number.isInteger(level) || level < 1 || level > 5 || typeof reason !== 'string')
      return undefined
    return { message, risk: { level, reason } }
  }
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
