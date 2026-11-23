import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'
import { parseNodeDefinitions } from './allmon3/index.js'
import { createApplication } from './application.js'
import { loadAiConfig, loadConfig } from './config.js'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
loadEnv({ path: resolve(repositoryRoot, '.env'), quiet: true })

const config = loadConfig()
const aiConfig = loadAiConfig()
const nodeDefinitions = parseNodeDefinitions(JSON.parse(
  readFileSync(resolve(repositoryRoot, 'config/nodes.json'), 'utf8'),
) as unknown)
const { app, start, shutdown } = createApplication({ config, aiConfig, nodeDefinitions, repositoryRoot })

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(signal)
      .catch(error => app.log.error(error, 'Shutdown failed'))
      .finally(() => process.exit(0))
  })
}

void start().catch((error) => {
  app.log.error(error, 'Unable to start iaxweb')
  void shutdown('startup failure').finally(() => {
    process.exitCode = 1
  })
})
