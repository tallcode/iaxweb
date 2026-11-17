import { readFileSync } from 'node:fs'
import { logTimestamp } from './asr-context-files.js'
import { compileSchema } from './schema-validator.js'

export interface LoadedSchema {
  object: Record<string, unknown>
  raw: string
  validate: (value: unknown) => string | undefined
}

export class LlmConfigFiles {
  private lastPrompt: string | undefined
  private lastSchema: LoadedSchema | undefined

  constructor(private readonly options: { promptFile: string, schemaFile: string }) {}

  loadPrompt(): string | undefined {
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

  loadSchema(): LoadedSchema | undefined {
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

    if (this.lastSchema?.raw === raw)
      return this.lastSchema
    try {
      const object = JSON.parse(raw) as unknown
      if (typeof object === 'object' && object !== null && !Array.isArray(object)) {
        const compiled = compileSchema(object as Record<string, unknown>)
        const loaded = { object: object as Record<string, unknown>, raw, validate: compiled }
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
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
