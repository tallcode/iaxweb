export interface LlmClientOptions {
  apiKey: string
  baseUrl: string
  fetchImpl?: typeof fetch
  retryDelaysMs?: number[]
  timeoutMs?: number
}

export class LlmClient {
  private readonly url: string
  private readonly fetchImpl: typeof fetch
  private readonly retryDelaysMs: number[]
  private readonly timeoutMs: number

  constructor(private readonly options: LlmClientOptions) {
    this.url = `${options.baseUrl}/chat/completions`
    this.fetchImpl = options.fetchImpl ?? fetch
    this.retryDelaysMs = options.retryDelaysMs ?? [1_000]
    this.timeoutMs = options.timeoutMs ?? 30_000
  }

  async requestWithRetry(body: unknown): Promise<string> {
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

  async requestOnce(body: unknown): Promise<string> {
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

function isRetryable(error: unknown): boolean {
  if (!(error instanceof LlmError))
    return false
  if (error.status === undefined)
    return true
  return error.status === 429 || error.status >= 500
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sleep(ms: number): Promise<void> {
  return new Promise(done => setTimeout(done, ms))
}
