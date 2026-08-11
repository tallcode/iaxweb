import { Buffer } from 'node:buffer'
import { CONTEXT_CHAR_LIMIT } from './context-store.js'
import { SAMPLE_RATE } from './mulaw.js'

export interface AsrClientOptions {
  apiKey: string
  baseUrl: string
  model: string
  fetchImpl?: typeof fetch
  retryDelaysMs?: number[]
  timeoutMs?: number
}

export interface TranscriptionContext {
  background?: string | undefined
  hotwords?: Record<string, number> | undefined
  previous?: string | undefined
}

export class AsrError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'AsrError'
  }
}

const ASR_PATH = '/api/v1/services/aigc/multimodal-generation/generation'
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_RETRY_DELAYS_MS = [1_000, 3_000]

// Synchronous DashScope ASR client (multimodal-generation endpoint). Sends
// one closed audio segment per request with instant hotwords and the rolling
// background/previous-transcript context.
export class AsrClient {
  private readonly apiKey: string
  private readonly url: string
  private readonly model: string
  private readonly fetchImpl: typeof fetch
  private readonly retryDelaysMs: number[]
  private readonly timeoutMs: number

  constructor(options: AsrClientOptions) {
    this.apiKey = options.apiKey
    this.url = `${options.baseUrl}${ASR_PATH}`
    this.model = options.model
    this.fetchImpl = options.fetchImpl ?? fetch
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  async transcribe(wav: Uint8Array, context: TranscriptionContext = {}): Promise<string> {
    const body = buildRequestBody(this.model, wav, context)
    let lastError: unknown = new AsrError('ASR request failed')
    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt++) {
      try {
        return await this.requestOnce(body)
      }
      catch (error) {
        lastError = error
        const delay = this.retryDelaysMs[attempt]
        if (delay === undefined || attempt >= this.retryDelaysMs.length || !isRetryable(error))
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
          'authorization': `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        method: 'POST',
        signal: controller.signal,
      })
    }
    catch (error) {
      clearTimeout(timer)
      throw new AsrError(`网络错误: ${errorMessage(error)}`)
    }

    let text: string
    try {
      text = await response.text()
    }
    finally {
      clearTimeout(timer)
    }

    if (!response.ok && isNoWordsResponse(text))
      return ''
    if (!response.ok)
      throw new AsrError(`HTTP ${response.status}: ${errorDetail(text)}`, response.status)

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    }
    catch {
      throw new AsrError(`响应不是有效 JSON: ${text.slice(0, 200)}`)
    }

    const transcription = extractAsrText(parsed)
    if (transcription === undefined)
      throw new AsrError(`响应中没有识别文本: ${text.slice(0, 200)}`)
    return transcription
  }
}

export function buildRequestBody(model: string, wav: Uint8Array, context: TranscriptionContext): Record<string, unknown> {
  const audioUrl = `data:audio/wav;base64,${Buffer.from(wav).toString('base64')}`
  const messages: Array<Record<string, unknown>> = []
  const background = context.background?.slice(0, CONTEXT_CHAR_LIMIT)
  if (background)
    messages.push({ content: [{ text: background }], role: 'user' })

  // DashScope counts all context text in the turn against one 400-character
  // budget. Keep the static background intact and use the remaining space for
  // the newest end of the rolling transcript. A prior ASR transcript is user
  // input, not an assistant response.
  const previousBudget = CONTEXT_CHAR_LIMIT - (background?.length ?? 0)
  const previous = previousBudget > 0 ? context.previous?.slice(-previousBudget) : undefined
  if (previous)
    messages.push({ content: [{ text: previous }], role: 'user' })
  // The audio message must be the last one.
  messages.push({ content: [{ audio: audioUrl }], role: 'user' })

  return {
    input: { messages },
    model,
    parameters: {
      format: 'wav',
      sample_rate: String(SAMPLE_RATE),
      ...(context.hotwords && Object.keys(context.hotwords).length > 0
        ? { vocabulary: context.hotwords }
        : {}),
    },
  }
}

// Different model revisions return the text in slightly different places.
export function extractAsrText(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null)
    return undefined
  const output = (body as { output?: unknown }).output
  if (typeof output !== 'object' || output === null)
    return undefined

  const record = output as Record<string, unknown>
  if (typeof record.text === 'string')
    return record.text
  const sentence = record.sentence as Record<string, unknown> | undefined
  if (sentence && typeof sentence.text === 'string')
    return sentence.text
  const nested = record.output as Record<string, unknown> | undefined
  const nestedSentence = nested?.sentence as Record<string, unknown> | undefined
  if (nestedSentence && typeof nestedSentence.text === 'string')
    return nestedSentence.text
  const choices = record.choices as Array<Record<string, unknown>> | undefined
  const choiceContent = choices?.[0]?.message as Record<string, unknown> | undefined
  if (choiceContent && typeof choiceContent.content === 'string')
    return choiceContent.content
  return undefined
}

function isRetryable(error: unknown): boolean {
  if (!(error instanceof AsrError))
    return false
  if (error.status === undefined)
    return true // network failure or timeout
  return error.status === 429 || error.status >= 500
}

function errorDetail(text: string): string {
  try {
    const parsed = JSON.parse(text) as { code?: unknown, message?: unknown }
    if (typeof parsed.message === 'string')
      return `${parsed.code ?? 'error'}: ${parsed.message}`
  }
  catch {
    // Fall through to the raw text.
  }
  return text.slice(0, 200)
}

// DashScope reports a valid silent/no-speech result as HTTP 400 instead of an
// empty successful transcription. Treat only this specific response as empty;
// all other client errors must remain visible.
function isNoWordsResponse(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as { code?: unknown, message?: unknown }
    return [parsed.code, parsed.message]
      .some(value => typeof value === 'string' && value.toUpperCase().includes('ASR_RESPONSE_HAVE_NO_WORDS'))
  }
  catch {
    return text.toUpperCase().includes('ASR_RESPONSE_HAVE_NO_WORDS')
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sleep(ms: number): Promise<void> {
  return new Promise(done => setTimeout(done, ms))
}
