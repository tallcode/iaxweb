// 手动验证 LLM 解析：npm run llm-parse-test -- "语音识别文本"
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'
import { LlmParser } from '../src/ai/llm-parser.js'
import { loadAiConfig } from '../src/config.js'

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../..', '.env'), quiet: true })

const text = process.argv.slice(2).join(' ').trim()
if (!text) {
  console.error('用法: npm run llm-parse-test -- "语音识别文本"')
  process.exit(1)
}

const config = loadAiConfig()
if (!config.llm.apiKey) {
  console.error('未配置 AI_LLM_API_KEY')
  process.exit(1)
}

const parser = new LlmParser({
  apiKey: config.llm.apiKey,
  baseUrl: config.llm.baseUrl,
  ...(config.llm.enableThinking !== undefined ? { enableThinking: config.llm.enableThinking } : {}),
  model: config.llm.model,
  promptFile: config.llm.promptFile,
  schemaFile: config.llm.schemaFile,
  ...(config.llm.thinkingBudget !== undefined ? { thinkingBudget: config.llm.thinkingBudget } : {}),
  timeoutMs: config.llm.timeoutMs,
})

try {
  const parsed = await parser.parse(text)
  if (!parsed) {
    console.error('LLM 解析未生效：缺少提示词或 schema 文件')
    process.exit(1)
  }
  console.log(JSON.stringify(parsed, null, 2))
}
catch (error) {
  console.error(`LLM 解析失败: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
