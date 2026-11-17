import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { config as loadEnv } from 'dotenv'
import { runEmbeddingBackfill } from '../src/ai/embedding-backfill.js'
import { loadAiConfig } from '../src/config.js'

const { values } = parseArgs({
  options: {
    'dry-run': { type: 'boolean' },
    'retry-failed': { type: 'boolean' },
    'retry-unavailable': { type: 'boolean' },
    'limit': { type: 'string' },
    'delay-ms': { type: 'string' },
    'database': { type: 'string' },
    'recordings': { type: 'string' },
    'model': { type: 'string' },
    'help': { type: 'boolean', short: 'h' },
  },
})

if (values.help) {
  console.log(`用法：npm run backfill:speaker -- [选项]

  --dry-run              只盘点并保存固定候选清单，不写数据库
  --limit 500            本次最多处理 500 个候选；之后可续跑
  --delay-ms 100         每条间隔毫秒，默认 100，范围 0..60000
  --retry-failed         仅重试当前版本的 failed
  --retry-unavailable    仅重新检查当前版本的 unavailable（例如录音已恢复）
  --database <文件>       覆盖 AI_DATABASE_FILE
  --recordings <目录>     覆盖 AI_RECORDINGS_DIR
  --model <文件>          覆盖 AI_SPEAKER_MODEL_FILE（仍须通过固定模型哈希校验）

只处理当前已标注的历史记录（重试同样受此限制）。取消标注后不再写入，保留已有声纹。
默认补算缺失及旧版本声纹；当前版本 ready/pending 不覆盖，pending 由在线标注任务恢复。
执行前自动创建并验证数据库备份。Ctrl+C 安全暂停。
再次执行相同命令会自动继续未完成任务，任务文件由程序管理，无需指定目录。`)
}
else {
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    if (values['retry-failed'] && values['retry-unavailable'])
      throw new Error('retry-failed 与 retry-unavailable 不能同时使用')
    const integer = (value: string | undefined, name: string, min: number, max = Number.MAX_SAFE_INTEGER) => {
      if (value === undefined)
        return undefined
      const number = Number(value)
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < min || number > max)
        throw new Error(`${name} 必须是 ${min}..${max} 的整数`)
      return number
    }
    const limit = integer(values.limit, 'limit', 1)
    const delayMs = integer(values['delay-ms'], 'delay-ms', 0, 60_000)
    const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
    loadEnv({ path: resolve(repositoryRoot, '.env'), quiet: true })
    const config = loadAiConfig()
    const result = await runEmbeddingBackfill({
      databaseFile: values.database ? resolve(values.database) : config.databaseFile,
      recordingsDirectory: values.recordings ? resolve(values.recordings) : config.recordingsDirectory,
      modelFile: values.model ? resolve(values.model) : config.speakerModelFile,
      ...(limit !== undefined ? { limit } : {}),
      ...(delayMs !== undefined ? { delayMs } : {}),
      dryRun: values['dry-run'] === true,
      mode: values['retry-failed'] ? 'failed' : values['retry-unavailable'] ? 'unavailable' : 'missing',
      signal: controller.signal,
    })
    if (result.progress.phase !== 'complete') {
      const modeFlag = values['retry-failed'] ? ' -- --retry-failed' : values['retry-unavailable'] ? ' -- --retry-unavailable' : ''
      console.log(`继续执行即可自动续跑：npm run backfill:speaker${modeFlag}`)
    }
    if (controller.signal.aborted)
      process.exitCode = 130
  }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = controller.signal.aborted ? 130 : 1
  }
  finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
  }
}
