import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { closeSync, openSync, readSync } from 'node:fs'
import process from 'node:process'
import { SPEAKER_DIMENSIONS, SPEAKER_MODEL_SHA256, SPEAKER_VERSION } from './speaker-model.mjs'
import { checkSpeakerQuality } from './speaker-quality.mjs'

// One job per process: native allocators and model arenas are released by the
// OS on exit, including after a timeout or an out-of-memory kill.
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
  try {
    const quality = checkSpeakerQuality(samples)
    if (!quality.accepted) {
      send({ status: 'unavailable', reason: quality.reason, version: SPEAKER_VERSION })
      return
    }
    verifyModel(process.argv[2])
    const { default: sherpa } = await import('sherpa-onnx-node')
    if (sherpa.version !== '2.0.1')
      throw new Error(`Unsupported sherpa native version: ${sherpa.version}`)
    const extractor = new sherpa.SpeakerEmbeddingExtractor({
      model: process.argv[2],
      numThreads: 1,
      provider: 'cpu',
      debug: false,
    })
    if (extractor.dim !== SPEAKER_DIMENSIONS)
      throw new Error(`Unexpected speaker embedding dimension: ${extractor.dim}`)
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
    if (!Number.isFinite(norm) || norm <= 0 || embedding.length !== SPEAKER_DIMENSIONS)
      throw new Error('Invalid speaker embedding')
    send({ embedding: Float32Array.from(embedding, value => value / norm), version: SPEAKER_VERSION })
  }
  catch (error) {
    send({ error: error instanceof Error ? error.message : String(error) })
  }
})
