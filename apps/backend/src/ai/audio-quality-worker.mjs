import { parentPort } from 'node:worker_threads'
import { checkLegacySpeakerQuality, checkSpeakerQuality } from './speaker-quality.mjs'

parentPort.on('message', ({ samples, legacy }) => {
  try {
    const result = legacy ? checkLegacySpeakerQuality(samples) : checkSpeakerQuality(samples)
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
