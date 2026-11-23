import assert from 'node:assert/strict'
import test from 'node:test'
import { AiService } from '../../src/ai/service.js'
import { loadAiConfig } from '../../src/config.js'

test('AI stop does not close an injected repository owned by the server', () => {
  let closes = 0
  const repository = {
    find: () => undefined,
    insert() {},
    updateAutomaticCallsign: () => false,
    close() { closes++ },
  }
  const config = loadAiConfig({ AI_PERSISTENCE_ENABLED: 'true', AI_LLM_ENABLED: 'false' })
  const service = new AiService({ config, nodeIds: [], repository })
  service.stop()
  service.stop()
  assert.equal(closes, 0)
  repository.close()
  assert.equal(closes, 1)
})

test('persistence must be provided explicitly instead of opening another database', () => {
  const config = loadAiConfig({ AI_PERSISTENCE_ENABLED: 'true', AI_LLM_ENABLED: 'false' })
  assert.throws(() => new AiService({ config, nodeIds: [] }), /injected recognition repository/)
})
