import { readFileSync } from 'node:fs'

// DashScope context enhancement truncates each turn's text silently beyond
// this limit; stay a little under it.
export const CONTEXT_CHAR_LIMIT = 400
const MAX_HOTWORDS = 2_000
const MAX_SUPER_HOTWORDS = 50
const HOTWORD_MAX_NON_ASCII_LENGTH = 15
const HOTWORD_MAX_ASCII_PARTS = 7

// Hotword and background files are re-read before every ASR request so edits
// take effect on the next segment without restarting the service.
export class AsrContextFiles {
  private lastHotwords: Record<string, number> | undefined

  constructor(
    private readonly hotwordsPath: string,
    private readonly backgroundPath: string,
  ) {}

  readHotwords(): Record<string, number> | undefined {
    let raw: string
    try {
      raw = readFileSync(this.hotwordsPath, 'utf8')
    }
    catch (error) {
      if (!isMissingFile(error))
        console.warn(`${logTimestamp()} [AI]: 热词文件读取失败 ${this.hotwordsPath}: ${errorMessage(error)}`)
      return this.lastHotwords
    }

    try {
      const validated = validateHotwords(JSON.parse(raw))
      this.lastHotwords = validated
      return validated
    }
    catch (error) {
      // Keep the last good table so a typo while editing does not disable
      // hotwords entirely.
      console.warn(`${logTimestamp()} [AI]: 热词文件解析失败，沿用上次有效配置: ${errorMessage(error)}`)
      return this.lastHotwords
    }
  }

  readBackground(): string | undefined {
    let text: string
    try {
      text = readFileSync(this.backgroundPath, 'utf8').trim()
    }
    catch (error) {
      if (!isMissingFile(error))
        console.warn(`${logTimestamp()} [AI]: 背景文件读取失败 ${this.backgroundPath}: ${errorMessage(error)}`)
      return undefined
    }

    if (!text)
      return undefined
    if (text.length > CONTEXT_CHAR_LIMIT) {
      console.warn(`${logTimestamp()} [AI]: 背景文本超过 ${CONTEXT_CHAR_LIMIT} 字，已截断（${text.length} 字）`)
      return text.slice(0, CONTEXT_CHAR_LIMIT)
    }
    return text
  }
}

// Validates the hotword file against the DashScope instant-vocabulary limits
// (weights 1..5 or 50, entry length rules, 2000 total, 50 super hotwords).
// Invalid entries are skipped with a warning instead of failing the request.
export function validateHotwords(value: unknown): Record<string, number> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    console.warn(`${logTimestamp()} [AI]: 热词文件必须是 {"词": 权重} 形式的 JSON 对象`)
    return undefined
  }

  const result: Record<string, number> = {}
  let superCount = 0
  for (const [word, weight] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(result).length >= MAX_HOTWORDS) {
      console.warn(`${logTimestamp()} [AI]: 热词数量超过 ${MAX_HOTWORDS}，多余词条已忽略`)
      break
    }
    if (!word || typeof weight !== 'number' || !Number.isInteger(weight)
      || !((weight >= 1 && weight <= 5) || weight === 50)) {
      console.warn(`${logTimestamp()} [AI]: 忽略无效热词 "${word}"（权重须为 1~5 或 50 的整数）`)
      continue
    }
    if (!isValidHotwordText(word)) {
      console.warn(`${logTimestamp()} [AI]: 忽略无效热词 "${word}"（非 ASCII 词最长 ${HOTWORD_MAX_NON_ASCII_LENGTH} 字符，ASCII 词最多 ${HOTWORD_MAX_ASCII_PARTS} 个空格分段）`)
      continue
    }
    if (weight === 50) {
      superCount++
      if (superCount > MAX_SUPER_HOTWORDS) {
        console.warn(`${logTimestamp()} [AI]: 超热词（权重50）超过 ${MAX_SUPER_HOTWORDS} 个，"${word}" 已忽略`)
        continue
      }
    }
    result[word] = weight
  }

  return Object.keys(result).length > 0 ? result : undefined
}

function isValidHotwordText(word: string): boolean {
  if (isAsciiOnly(word))
    return word.split(/\s+/).filter(Boolean).length <= HOTWORD_MAX_ASCII_PARTS
  return word.length <= HOTWORD_MAX_NON_ASCII_LENGTH
}

function isAsciiOnly(word: string): boolean {
  for (let index = 0; index < word.length; index++) {
    if (word.charCodeAt(index) > 0x7F)
      return false
  }
  return true
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Local-time stamp for AI log lines: [YYMMdd HH:mm:ss].
export function logTimestamp(date: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `[${pad(date.getFullYear() % 100)}${pad(date.getMonth() + 1)}${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}]`
}
