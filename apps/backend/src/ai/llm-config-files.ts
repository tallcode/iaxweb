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

interface LoadedPrompts {
  stage1: string
  stage2: string
  stage2Review: string
}

export class LlmConfigFiles {
  private lastSchema: LoadedSchema | undefined

  constructor(private readonly options: LlmConfigFilePaths) {}

  loadPrompts(): LoadedPrompts | undefined {
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
    const parts = text.split(/^#{9}[^\r\n]*/mu).map(part => part.trim())
    const [stage1, stage2, stage2Review] = parts
    if (parts.length !== 3 || !stage1 || !stage2 || !stage2Review)
      return undefined
    return { stage1, stage2, stage2Review }
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
