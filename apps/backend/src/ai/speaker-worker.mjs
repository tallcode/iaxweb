import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { parentPort, workerData } from 'node:worker_threads'
import sherpa from 'sherpa-onnx-node'
import { SPEAKER_MODEL_SHA256, SPEAKER_VERSION } from './speaker-model.mjs'
import { checkSpeakerQuality } from './speaker-quality.mjs'

const hash = createHash('sha256').update(readFileSync(workerData.modelFile)).digest('hex')
if (hash !== SPEAKER_MODEL_SHA256)
  throw new Error('Speaker model SHA-256 mismatch; use npm run download:speaker-model')
if (sherpa.version !== '2.0.1')
  throw new Error(`Unsupported sherpa native version: ${sherpa.version}`)
const extractor = new sherpa.SpeakerEmbeddingExtractor({
  model: workerData.modelFile,
  numThreads: 2,
  provider: 'cpu',
  debug: false,
})
if (extractor.dim !== 256)
  throw new Error(`Unexpected speaker embedding dimension: ${extractor.dim}`)

parentPort.on('message', ({ id, samples }) => {
  try {
    const quality = checkSpeakerQuality(samples)
    if (!quality.accepted) {
      parentPort.postMessage({ id, status: 'unavailable', reason: quality.reason, version: SPEAKER_VERSION })
      return
    }
    const stream = extractor.createStream()
    stream.acceptWaveform({ samples, sampleRate: 8000 })
    stream.inputFinished()
    if (!extractor.isReady(stream))
      throw new Error('Insufficient audio for speaker embedding')
    const embedding = extractor.compute(stream, false)
    let squared = 0
    for (const value of embedding)
      squared += value * value
    const norm = Math.sqrt(squared)
    if (!Number.isFinite(norm) || norm <= 0 || embedding.length !== 256)
      throw new Error('Invalid speaker embedding')
    const normalized = Float32Array.from(embedding, value => value / norm)
    parentPort.postMessage({ id, embedding: normalized, version: SPEAKER_VERSION }, [normalized.buffer])
  }
  catch (error) {
    parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
  }
})
