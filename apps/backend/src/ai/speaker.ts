import type { Buffer } from 'node:buffer'
import type { ChildProcess } from 'node:child_process'
import type { Voiceprint } from '../records/types.js'
import { fork } from 'node:child_process'
import { setPriority } from 'node:os'
import process from 'node:process'
import { SPEAKER_DIMENSIONS, SPEAKER_VERSION } from './speaker-model.mjs'
import { SPEAKER_MAX_SAMPLES, SPEAKER_TOO_LONG_REASON, speakerMemoryBudget, speakerProcessRss, speakerRequiredMemory } from './speaker-resources.js'

export { SPEAKER_DIMENSIONS } from './speaker-model.mjs'
const MIN_VOICED_MS = 1_000
const EXTRACTION_TIMEOUT_MS = 60_000
const RETRY_DELAY_MS = 60_000
const MAX_QUEUED_EXTRACTIONS = 4

interface QueuedExtraction {
  samples: Float32Array
  resolve: (voiceprint: Voiceprint) => void
  reject: (error: Error) => void
  signal: AbortSignal | undefined
  onAbort: () => void
}

interface ExtractionMessage {
  status?: string
  reason?: string
  embedding?: Float32Array
  version?: string
  error?: string
  rss?: number
}

// Single-flight, single-use native process. Never start another model until the
// previous process has closed; Worker.terminate cannot preempt a native call.
export class SpeakerExtractor {
  private child: ChildProcess | undefined
  private cancel: ((error: Error) => void) | undefined
  private failure: Error | undefined
  private retryAt = 0
  private stopped = false
  private draining = false
  private readonly queue: QueuedExtraction[] = []

  constructor(private readonly modelFile: string) {}

  get backingOff(): boolean {
    return this.failure !== undefined && Date.now() < this.retryAt
  }

  get busy(): boolean {
    return this.draining || this.child !== undefined || this.queue.length > 0
  }

  extract(samples: Float32Array, voicedMs: number, signal?: AbortSignal): Promise<Voiceprint> {
    if (this.stopped)
      return Promise.reject(new Error('Speaker extractor stopped'))
    if (signal?.aborted)
      return Promise.reject(new Error('Speaker extraction cancelled'))
    if (voicedMs < MIN_VOICED_MS || samples.length < 8_000)
      return Promise.resolve({ status: 'unavailable', version: SPEAKER_VERSION, reason: 'insufficient_audio' })
    if (samples.length > SPEAKER_MAX_SAMPLES)
      return Promise.resolve({ status: 'unavailable', version: SPEAKER_VERSION, reason: SPEAKER_TOO_LONG_REASON })
    if (this.queue.length >= MAX_QUEUED_EXTRACTIONS)
      return Promise.reject(new Error('Speaker extraction queue full'))
    if (this.backingOff)
      return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      const job: QueuedExtraction = {
        // Own the queued waveform; callers may reuse their audio buffer.
        samples: Float32Array.from(samples),
        resolve,
        reject,
        signal,
        onAbort: () => {
          const index = this.queue.indexOf(job)
          if (index >= 0) {
            this.queue.splice(index, 1)
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
    if (this.draining || this.stopped)
      return
    this.draining = true
    try {
      while (this.queue.length > 0 && !this.stopped) {
        const job = this.queue.shift()!
        job.signal?.removeEventListener('abort', job.onAbort)
        try {
          const result = await this.run(job.samples, job.signal)
          job.resolve(result)
        }
        catch (error) {
          job.reject(error instanceof Error ? error : new Error(String(error)))
          if (this.backingOff) {
            this.rejectQueued(this.failure!)
            break
          }
        }
      }
    }
    finally { this.draining = false }
  }

  private run(samples: Float32Array, signal?: AbortSignal): Promise<Voiceprint> {
    if (signal?.aborted)
      return Promise.reject(new Error('Speaker extraction cancelled'))
    let budget: number
    try {
      budget = speakerMemoryBudget()
    }
    catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      this.backoff(failure)
      return Promise.reject(failure)
    }
    if (budget < speakerRequiredMemory(samples.length)) {
      const error = new Error('Speaker extraction insufficient memory')
      this.backoff(error)
      return Promise.reject(error)
    }
    this.failure = undefined
    return new Promise((resolve, reject) => {
      let result: Voiceprint | undefined
      let failure: Error | undefined
      let stderr = ''
      const child = fork(new URL('./speaker-worker.mjs', import.meta.url), [this.modelFile], {
        execArgv: [],
        serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: { ...process.env, OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1', MKL_NUM_THREADS: '1', MALLOC_ARENA_MAX: '2' },
      })
      this.child = child
      child.once('spawn', () => {
        try {
          if (child.pid)
            setPriority(child.pid, 10)
        }
        catch { /* Container CPU limits remain the hard boundary. */ }
      })
      const fail = (error: Error, backoff = true) => {
        if (failure)
          return
        failure = error
        if (backoff)
          this.backoff(error)
        child.kill('SIGKILL')
      }
      this.cancel = error => fail(error, false)
      const onAbort = () => fail(new Error('Speaker extraction cancelled'), false)
      signal?.addEventListener('abort', onAbort, { once: true })
      const timeout = setTimeout(() => fail(new Error('Speaker extraction timed out')), EXTRACTION_TIMEOUT_MS)
      const monitor = setInterval(() => {
        if (!child.pid || failure || result)
          return
        try {
          const rss = speakerProcessRss(child.pid)
          if (rss !== undefined) {
            const limit = Math.min(budget, speakerMemoryBudget(rss))
            if (rss > limit)
              fail(new Error(`Speaker extraction resource limit exceeded (RSS ${Math.ceil(rss / 1048576)} MiB, budget ${Math.floor(limit / 1048576)} MiB)`))
          }
        }
        catch (error) { fail(error instanceof Error ? error : new Error(String(error))) }
      }, 50)
      child.stderr?.on('data', (data: Buffer) => {
        stderr = (stderr + data.toString()).slice(-2_000)
      })
      child.on('message', (message: ExtractionMessage) => {
        if (failure || result)
          return
        if (message.rss !== undefined && message.rss > budget) {
          fail(new Error('Speaker extraction resource limit exceeded'))
          return
        }
        if (message.error) {
          fail(new Error(message.error))
        }
        else if (message.version !== SPEAKER_VERSION) {
          fail(new Error('Invalid speaker process version'))
        }
        else if (message.status === 'unavailable' && !message.embedding && typeof message.reason === 'string' && message.reason.length > 0) {
          result = { status: 'unavailable', version: SPEAKER_VERSION, reason: message.reason }
        }
        else if (message.embedding instanceof Float32Array && validEmbedding(message.embedding)) {
          result = { status: 'ready', version: SPEAKER_VERSION, embedding: message.embedding }
        }
        else { fail(new Error('Invalid speaker process result')) }
      })
      child.on('error', fail)
      child.once('close', (code, exitSignal) => {
        clearTimeout(timeout)
        clearInterval(monitor)
        signal?.removeEventListener('abort', onAbort)
        if (this.child === child) {
          this.child = undefined
          this.cancel = undefined
        }
        if (!failure && (!result || code !== 0)) {
          failure = new Error(`Speaker process exited (${exitSignal ?? code}): ${stderr}`)
          this.backoff(failure)
        }
        if (failure)
          reject(failure)
        else
          resolve(result!)
      })
      try {
        child.send({ samples }, error => error && fail(error))
      }
      catch (error) { fail(error instanceof Error ? error : new Error(String(error))) }
    })
  }

  stop(): void {
    this.stopped = true
    this.rejectQueued(new Error('Speaker extractor stopped'))
    this.cancel?.(new Error('Speaker extractor stopped'))
  }

  private rejectQueued(error: Error): void {
    for (const job of this.queue.splice(0)) {
      job.signal?.removeEventListener('abort', job.onAbort)
      job.reject(error)
    }
  }

  private backoff(error: Error): void {
    this.failure = error
    this.retryAt = Date.now() + RETRY_DELAY_MS
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
