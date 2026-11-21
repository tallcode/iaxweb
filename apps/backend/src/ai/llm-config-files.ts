import { readFileSync } from 'node:fs'
import { logTimestamp } from './asr-context-files.js'
import { compileSchema } from './schema-validator.js'

export interface LoadedSchema {
  object: Record<string, unknown>
  raw: string
  validate: (value: unknown) => string | undefined
}

export interface LlmConfigFilePaths {
  promptFile: string
  schemaFile: string
}

export class LlmConfigFiles {
  private lastSchema: LoadedSchema | undefined

  constructor(private readonly options: LlmConfigFilePaths) {}

  loadPrompt(): string | undefined {
    const { promptFile } = this.options
    let text: string
    try {
      text = readFileSync(promptFile, 'utf8')
    }
    catch (error) {
      if (!isMissingFile(error))
        console.warn(`${logTimestamp()} [AI]: 提示词文件读取失败 ${promptFile}: ${errorMessage(error)}`)
      return undefined
    }
    return text.trim() || undefined
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
      this.lastSchema = undefined
      return undefined
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
      console.warn(`${logTimestamp()} [AI]: schema 文件必须是 JSON 对象，跳过识别`)
    }
    catch (error) {
      console.warn(`${logTimestamp()} [AI]: schema 文件解析失败，跳过识别: ${errorMessage(error)}`)
    }
    this.lastSchema = undefined
    return undefined
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
