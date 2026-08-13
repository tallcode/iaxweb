// 手动验证 LLM 解析：npm run llm-parse-test -- "语音识别文本"
import process from 'node:process'
import { config as loadEnv } from 'dotenv'
import { LlmParser } from '../src/ai/llm-parser.js'
import { loadAiConfig } from '../src/config.js'

loadEnv({ quiet: true })

const text = process.argv.slice(2).join(' ').trim()
if (!text) {
  console.error('用法: npm run llm-parse-test -- "语音识别文本"')
  process.exit(1)
}

const config = loadAiConfig()
if (!config.apiKey) {
  console.error('未配置 DASHSCOPE_API_KEY')
  process.exit(1)
}

const parser = new LlmParser({
  apiKey: config.apiKey,
  baseUrl: config.baseUrl,
  ...(config.llmEnableThinking ? { enableThinking: true } : {}),
  model: config.llmModel,
  promptFile: config.llmPromptFile,
  schemaFile: config.llmSchemaFile,
  ...(config.llmThinkingBudget !== undefined ? { thinkingBudget: config.llmThinkingBudget } : {}),
  timeoutMs: config.llmTimeoutMs,
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
