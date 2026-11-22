import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { closeSync, openSync, readSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { SPEAKER_DIMENSIONS, SPEAKER_MODEL_SHA256, SPEAKER_VERSION } from './speaker-model.mjs'
import { checkSpeakerQuality } from './speaker-quality.mjs'
import { scoreSpeakerReferences } from './speaker-reference-score.mjs'

// Reuse the model, never the per-record stream. The parent supervises and
// recycles it when idle or under memory pressure to release native arenas.
let extractor
let native
let requestId
let busy = false

function progress(message) {
  process.send?.({ ...message, requestId })
}

function measure(stage, operation) {
  progress({ event: 'stageStarted', stage })
  const started = performance.now()
  try {
    return operation()
  }
  finally {
    progress({ event: 'stageCompleted', stage, durationMs: performance.now() - started })
  }
}

async function measureAsync(stage, operation) {
  progress({ event: 'stageStarted', stage })
  const started = performance.now()
  try {
    return await operation()
  }
  finally {
    progress({ event: 'stageCompleted', stage, durationMs: performance.now() - started })
  }
}

function send(result) {
  process.send?.({ ...result, requestId, rss: process.memoryUsage().rss }, (error) => {
    if (error)
      process.exit(1)
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

async function loadNative() {
  if (!native) {
    native = (await measureAsync('nativeLibraryLoadMs', () => import('sherpa-onnx-node'))).default
    if (native.version !== '2.0.1')
      throw new Error(`Unsupported sherpa native version: ${native.version}`)
  }
  return native
}

process.on('disconnect', () => process.exit(0))

process.on('message', async (message) => {
  if (busy)
    process.exit(1)
  busy = true
  requestId = message.requestId
  const samples = message.samples
  progress({ event: 'started' })
  try {
    if (message.operation === 'references') {
      const sherpa = await loadNative()
      const scores = measure('referenceMatchMs', () => scoreSpeakerReferences(sherpa, message.embedding, message.groups))
      send({ scores, version: SPEAKER_VERSION })
      return
    }
    if (!message.qualityApproved) {
      const quality = measure('qualityCheckMs', () => checkSpeakerQuality(samples))
      if (!quality.accepted) {
        send({ status: 'unavailable', reason: quality.reason, version: SPEAKER_VERSION })
        return
      }
    }
    if (!extractor) {
      measure('modelValidationMs', () => verifyModel(process.argv[2]))
      const sherpa = await loadNative()
      extractor = measure('modelLoadMs', () => new sherpa.SpeakerEmbeddingExtractor({
        model: process.argv[2],
        numThreads: 2,
        provider: 'cpu',
        debug: false,
      }))
      if (extractor.dim !== SPEAKER_DIMENSIONS)
        throw new Error(`Unexpected speaker embedding dimension: ${extractor.dim}`)
    }
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
  finally { busy = false }
})
