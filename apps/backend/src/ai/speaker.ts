import type { Voiceprint } from '../records/types.js'
import { Worker } from 'node:worker_threads'
import { SPEAKER_DIMENSIONS, SPEAKER_VERSION } from './speaker-model.mjs'

export { SPEAKER_DIMENSIONS } from './speaker-model.mjs'
const MIN_VOICED_MS = 1_000
const EXTRACTION_TIMEOUT_MS = 10_000
const RETRY_DELAY_MS = 60_000
const MAX_PENDING_EXTRACTIONS = 16

interface PendingExtraction {
  resolve: (voiceprint: Voiceprint) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

// One resident native model, shared by nodes, outside the gateway event loop.
export class SpeakerExtractor {
  private worker: Worker | undefined
  private failure: Error | undefined
  private retryAt = 0
  private stopped = false
  private nextId = 0
  private readonly pending = new Map<number, PendingExtraction>()

  constructor(private readonly modelFile: string) {}

  get backingOff(): boolean {
    return this.failure !== undefined && Date.now() < this.retryAt
  }

  extract(samples: Float32Array, voicedMs: number): Promise<Voiceprint> {
    if (this.stopped)
      return Promise.reject(new Error('Speaker extractor stopped'))
    if (voicedMs < MIN_VOICED_MS || samples.length < 8_000)
      return Promise.resolve({ status: 'unavailable', version: SPEAKER_VERSION, reason: 'insufficient_audio' })
    if (this.failure && Date.now() < this.retryAt)
      return Promise.reject(this.failure)
    this.failure = undefined
    if (this.pending.size >= MAX_PENDING_EXTRACTIONS)
      return Promise.reject(new Error('Speaker extraction queue full'))
    this.start()
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const timeout = setTimeout(() => this.fail(new Error('Speaker extraction timed out')), EXTRACTION_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timeout })
      // Copy into an owned buffer so transferring never detaches ASR audio.
      const owned = Float32Array.from(samples)
      try {
        this.worker!.postMessage({ id, samples: owned }, [owned.buffer])
      }
      catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  stop(): void {
    this.stopped = true
    this.fail(new Error('Speaker extractor stopped'))
  }

  private start(): void {
    if (this.worker)
      return
    // This worker is plain ESM; application loaders/eval/debug flags must not
    // leak into it (e.g. --input-type is invalid for a worker file).
    const worker = new Worker(new URL('./speaker-worker.mjs', import.meta.url), {
      execArgv: [],
      workerData: { modelFile: this.modelFile },
    })
    this.worker = worker
    worker.on('message', (message: { id: number, status?: string, reason?: string, embedding?: Float32Array, version?: string, error?: string }) => {
      const pending = this.pending.get(message.id)
      if (!pending)
        return
      clearTimeout(pending.timeout)
      this.pending.delete(message.id)
      if (!message.error && message.status === 'unavailable' && message.version === SPEAKER_VERSION
        && !message.embedding && typeof message.reason === 'string' && message.reason.length > 0) {
        pending.resolve({ status: 'unavailable', version: message.version, reason: message.reason })
      }
      else if (message.error || !message.embedding || message.version !== SPEAKER_VERSION || !validEmbedding(message.embedding)) {
        pending.reject(new Error(message.error ?? 'Invalid speaker worker result'))
      }
      else {
        pending.resolve({ status: 'ready', version: message.version, embedding: message.embedding })
      }
    })
    worker.on('error', (error) => {
      if (this.worker === worker)
        this.fail(error instanceof Error ? error : new Error(String(error)))
    })
    worker.on('exit', (code) => {
      if (this.worker === worker)
        this.fail(new Error(`Speaker worker exited (${code})`))
    })
  }

  private fail(error: Error): void {
    this.failure ??= error
    this.retryAt = Date.now() + RETRY_DELAY_MS
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pending.clear()
    const worker = this.worker
    this.worker = undefined
    if (worker)
      void worker.terminate()
  }
}

export function validEmbedding(embedding: Float32Array): boolean {
  if (embedding.length !== SPEAKER_DIMENSIONS)
    return false
  let norm = 0
  for (const value of embedding) {
    if (!Number.isFinite(value))
      return false
    norm += value * value
  }
  return norm > 0 && Number.isFinite(norm)
}
