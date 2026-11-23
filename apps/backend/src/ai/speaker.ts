import type { SpeakerRecognitionMeasurements } from '@iaxweb/contracts'
import type { SpeakerReferenceGroup, SpeakerReferenceScore, Voiceprint } from '../records/types.js'
import type { SpeakerRequest, SpeakerResult } from './speaker-protocol.js'
import { performance } from 'node:perf_hooks'
import { SPEAKER_VERSION } from './speaker-model.mjs'
import { SpeakerWorkerProcess } from './speaker-process.js'
import { validEmbedding } from './speaker-protocol.js'
import { SPEAKER_MAX_SAMPLES, SPEAKER_TOO_LONG_REASON } from './speaker-resources.js'

export { SPEAKER_DIMENSIONS } from './speaker-model.mjs'
export { validEmbedding } from './speaker-protocol.js'

const MIN_VOICED_MS = 1_000
const MAX_QUEUED_EXTRACTIONS = 4

interface QueuedExtraction {
  request: SpeakerRequest
  resolve: (result: SpeakerResult) => void
  reject: (error: Error) => void
  signal: AbortSignal | undefined
  onAbort: () => void
  queuedAt: number
  measurements: SpeakerRecognitionMeasurements | undefined
}

export class SpeakerExtractor {
  private readonly worker: SpeakerWorkerProcess
  private draining = false
  private readonly queue: QueuedExtraction[] = []

  constructor(modelFile: string) {
    this.worker = new SpeakerWorkerProcess(modelFile)
  }

  get backingOff(): boolean {
    return this.worker.backoffError !== undefined
  }

  get busy(): boolean {
    return this.draining || this.queue.length > 0
  }

  extract(samples: Float32Array, voicedMs: number, signal?: AbortSignal, measurements?: SpeakerRecognitionMeasurements, qualityApproved = false): Promise<Voiceprint> {
    if (this.worker.stopped)
      return Promise.reject(new Error('Speaker extractor stopped'))
    if (signal?.aborted)
      return Promise.reject(new Error('Speaker extraction cancelled'))
    if (voicedMs < MIN_VOICED_MS || samples.length < 8_000)
      return Promise.resolve({ status: 'unavailable', version: SPEAKER_VERSION, reason: 'insufficient_audio' })
    if (samples.length > SPEAKER_MAX_SAMPLES)
      return Promise.resolve({ status: 'unavailable', version: SPEAKER_VERSION, reason: SPEAKER_TOO_LONG_REASON })
    return this.enqueue({ operation: 'extract', samples, qualityApproved }, signal, measurements).then((result) => {
      if (Array.isArray(result))
        throw new Error('Invalid speaker extraction response')
      return result
    })
  }

  scoreReferences(embedding: Float32Array, groups: SpeakerReferenceGroup[], signal?: AbortSignal): Promise<SpeakerReferenceScore[]> {
    if (!validEmbedding(embedding))
      return Promise.reject(new Error('Invalid reference query vector'))
    if (groups.length === 0)
      return Promise.resolve([])
    const request: SpeakerRequest = {
      operation: 'references',
      embedding,
      groups,
    }
    return this.enqueue(request, signal).then((result) => {
      if (!Array.isArray(result))
        throw new Error('Invalid speaker reference response')
      return result
    })
  }

  private enqueue(request: SpeakerRequest, signal?: AbortSignal, measurements?: SpeakerRecognitionMeasurements): Promise<SpeakerResult> {
    if (this.worker.stopped)
      return Promise.reject(new Error('Speaker extractor stopped'))
    if (signal?.aborted)
      return Promise.reject(new Error('Speaker extraction cancelled'))
    if (this.queue.length >= MAX_QUEUED_EXTRACTIONS)
      return Promise.reject(new Error('Speaker extraction queue full'))
    const backoffError = this.worker.backoffError
    if (backoffError)
      return Promise.reject(backoffError)
    return new Promise((resolve, reject) => {
      const job: QueuedExtraction = {
        // Requests own their buffers so callers can reuse the input arrays.
        request: request.operation === 'extract'
          ? { ...request, samples: Float32Array.from(request.samples) }
          : { ...request, embedding: Float32Array.from(request.embedding), groups: request.groups.map(group => ({ callsign: group.callsign, embeddings: group.embeddings.map(vector => Float32Array.from(vector)) })) },
        resolve,
        reject,
        signal,
        queuedAt: performance.now(),
        measurements,
        onAbort: () => {
          const index = this.queue.indexOf(job)
          if (index >= 0) {
            this.queue.splice(index, 1)
            if (measurements)
              measurements.queueWaitMs = performance.now() - job.queuedAt
            reject(new Error('Speaker extraction cancelled'))
          }
        },
      }
      signal?.addEventListener('abort', job.onAbort, { once: true })
      this.queue.push(job)
      void this.drain()
    })
  }

  private async drain(): Promise<void> {
    if (this.draining || this.worker.stopped)
      return
    this.draining = true
    try {
      while (this.queue.length > 0 && !this.worker.stopped) {
        const job = this.queue.shift()!
        job.signal?.removeEventListener('abort', job.onAbort)
        if (job.measurements)
          job.measurements.queueWaitMs = performance.now() - job.queuedAt
        try {
          const result = await this.worker.run(job.request, job.signal, job.measurements)
          job.resolve(result)
        }
        catch (error) {
          job.reject(error instanceof Error ? error : new Error(String(error)))
          const backoffError = this.worker.backoffError
          if (backoffError) {
            this.rejectQueued(backoffError)
            break
          }
        }
      }
    }
    finally { this.draining = false }
  }

  stop(): void {
    this.rejectQueued(new Error('Speaker extractor stopped'))
    this.worker.stop()
  }

  private rejectQueued(error: Error): void {
    for (const job of this.queue.splice(0)) {
      if (job.measurements)
        job.measurements.queueWaitMs = performance.now() - job.queuedAt
      job.signal?.removeEventListener('abort', job.onAbort)
      job.reject(error)
    }
  }
}
