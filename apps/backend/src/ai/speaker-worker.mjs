import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { closeSync, openSync, readSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { SPEAKER_DIMENSIONS, SPEAKER_MODEL_SHA256, SPEAKER_VERSION } from './speaker-model.mjs'
import { checkSpeakerQuality } from './speaker-quality.mjs'

// One job per process: native allocators and model arenas are released by the
// OS on exit, including after a timeout or an out-of-memory kill.
function measure(stage, operation) {
  process.send?.({ event: 'stageStarted', stage })
  const started = performance.now()
  try {
    return operation()
  }
  finally {
    process.send?.({ event: 'stageCompleted', stage, durationMs: performance.now() - started })
  }
}

async function measureAsync(stage, operation) {
  process.send?.({ event: 'stageStarted', stage })
  const started = performance.now()
  try {
    return await operation()
  }
  finally {
    process.send?.({ event: 'stageCompleted', stage, durationMs: performance.now() - started })
  }
}

function send(result) {
  process.send?.({ ...result, rss: process.memoryUsage().rss }, (error) => {
    process.exit(error ? 1 : 0)
  })
}

function verifyModel(filename) {
  const hash = createHash('sha256')
  const descriptor = openSync(filename, 'r')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  try {
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null)
      if (count === 0)
        break
      hash.update(buffer.subarray(0, count))
    }
  }
  finally { closeSync(descriptor) }
  if (hash.digest('hex') !== SPEAKER_MODEL_SHA256)
    throw new Error('Speaker model SHA-256 mismatch; use npm run download:speaker-model')
}

process.once('message', async ({ samples }) => {
  process.send?.({ event: 'started' })
  try {
    const quality = measure('qualityCheckMs', () => checkSpeakerQuality(samples))
    if (!quality.accepted) {
      send({ status: 'unavailable', reason: quality.reason, version: SPEAKER_VERSION })
      return
    }
    measure('modelValidationMs', () => verifyModel(process.argv[2]))
    const { default: sherpa } = await measureAsync('nativeLibraryLoadMs', () => import('sherpa-onnx-node'))
    if (sherpa.version !== '2.0.1')
      throw new Error(`Unsupported sherpa native version: ${sherpa.version}`)
    const extractor = measure('modelLoadMs', () => new sherpa.SpeakerEmbeddingExtractor({
      model: process.argv[2],
      numThreads: 1,
      provider: 'cpu',
      debug: false,
    }))
    if (extractor.dim !== SPEAKER_DIMENSIONS)
      throw new Error(`Unexpected speaker embedding dimension: ${extractor.dim}`)
    const stream = measure('featureExtractionMs', () => {
      const stream = extractor.createStream()
      stream.acceptWaveform({ samples, sampleRate: 8000 })
      stream.inputFinished()
      if (!extractor.isReady(stream))
        throw new Error('Insufficient audio for speaker embedding')
      return stream
    })
    const embedding = measure('embeddingComputeMs', () => extractor.compute(stream, false))
    const normalized = measure('embeddingNormalizeMs', () => {
      let squared = 0
      for (const value of embedding)
        squared += value * value
      const norm = Math.sqrt(squared)
      if (!Number.isFinite(norm) || norm <= 0 || embedding.length !== SPEAKER_DIMENSIONS)
        throw new Error('Invalid speaker embedding')
      return Float32Array.from(embedding, value => value / norm)
    })
    send({ embedding: normalized, version: SPEAKER_VERSION })
  }
  catch (error) {
    send({ error: error instanceof Error ? error.message : String(error) })
  }
})
