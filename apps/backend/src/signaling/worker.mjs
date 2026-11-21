import { parentPort } from 'node:worker_threads'
import { decodeSignaling } from './decoder.mjs'

parentPort.on('message', (windows) => {
  try {
    parentPort.postMessage(decodeSignaling(windows))
  }
  catch {
    parentPort.postMessage(null)
  }
})
