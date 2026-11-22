import { parentPort } from 'node:worker_threads'
import { checkSpeakerQuality } from './speaker-quality.mjs'

parentPort.on('message', (samples) => {
  try {
    const result = checkSpeakerQuality(samples)
    parentPort.postMessage({
      status: result.accepted ? 'passed' : 'rejected',
      reason: result.accepted ? null : result.reason,
      metrics: result.metrics ?? null,
    })
  }
  catch {
    parentPort.postMessage({ status: 'unknown', reason: 'check_failed', metrics: null })
  }
})
