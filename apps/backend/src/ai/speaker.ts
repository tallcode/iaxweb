import type { SpeakerRecognitionMeasurements } from '@iaxweb/contracts'
import type { Buffer } from 'node:buffer'
import type { ChildProcess } from 'node:child_process'
import type { SpeakerReferenceGroup, SpeakerReferenceScore, Voiceprint } from '../records/types.js'
import type { SpeakerWorkerMeasurementStage } from './speaker-measurements.js'
import { fork } from 'node:child_process'
import { setPriority } from 'node:os'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { SPEAKER_WORKER_MEASUREMENT_STAGES } from './speaker-measurements.js'
import { SPEAKER_DIMENSIONS, SPEAKER_VERSION } from './speaker-model.mjs'
import { SPEAKER_IDLE_TIMEOUT_MS, SPEAKER_MAX_SAMPLES, SPEAKER_RECYCLE_RSS, SPEAKER_TOO_LONG_REASON, speakerMemoryBudget, speakerProcessRss, speakerRequiredMemory } from './speaker-resources.js'

export { SPEAKER_DIMENSIONS } from './speaker-model.mjs'
const MIN_VOICED_MS = 1_000
const EXTRACTION_TIMEOUT_MS = 60_000
const RETRY_DELAY_MS = 60_000
const MAX_QUEUED_EXTRACTIONS = 4

type SpeakerRequest = { operation: 'extract', samples: Float32Array }
  | { operation: 'references', embedding: Float32Array, groups: SpeakerReferenceGroup[] }
type SpeakerResult = Voiceprint | SpeakerReferenceScore[]

interface QueuedExtraction {
  request: SpeakerRequest
  resolve: (result: SpeakerResult) => void
  reject: (error: Error) => void
  signal: AbortSignal | undefined
  onAbort: () => void
  queuedAt: number
  measurements: SpeakerRecognitionMeasurements | undefined
}

interface ExtractionMessage {
  requestId?: number
  event?: string
  stage?: string
  durationMs?: number
  status?: string
  reason?: string
  embedding?: Float32Array
  scores?: unknown
  version?: string
  error?: string
  rss?: number
}

interface RunningExtraction {
  id: number
  request: SpeakerRequest
  started: number
  cold: boolean
  budget: number
  measurements: SpeakerRecognitionMeasurements | undefined
  signal: AbortSignal | undefined
  onAbort: () => void
  timeout: ReturnType<typeof setTimeout>
  resolve: (result: SpeakerResult) => void
  reject: (error: Error) => void
  result?: SpeakerResult
  failure?: Error
  terminationRequested?: number
  activeStage?: { stage: SpeakerWorkerMeasurementStage, started: number }
}

interface SpeakerProcess {
  child: ChildProcess
  closed: Promise<void>
  started: boolean
  rss: number
  retiring: boolean
  lastIdleCheck: number
  stderr: string
  monitor: ReturnType<typeof setInterval>
  idleTimer?: ReturnType<typeof setTimeout>
  active?: RunningExtraction
}

// Single-flight resident native process. Recycling always waits for close
// before another model starts, including after timeout or cancellation.
export class SpeakerExtractor {
  private process: SpeakerProcess | undefined
  private nextRequestId = 0
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
    return this.draining || this.queue.length > 0
  }

  extract(samples: Float32Array, voicedMs: number, signal?: AbortSignal, measurements?: SpeakerRecognitionMeasurements): Promise<Voiceprint> {
    if (this.stopped)
      return Promise.reject(new Error('Speaker extractor stopped'))
    if (signal?.aborted)
      return Promise.reject(new Error('Speaker extraction cancelled'))
    if (voicedMs < MIN_VOICED_MS || samples.length < 8_000)
      return Promise.resolve({ status: 'unavailable', version: SPEAKER_VERSION, reason: 'insufficient_audio' })
    if (samples.length > SPEAKER_MAX_SAMPLES)
      return Promise.resolve({ status: 'unavailable', version: SPEAKER_VERSION, reason: SPEAKER_TOO_LONG_REASON })
    return this.enqueue({ operation: 'extract', samples }, signal, measurements).then((result) => {
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
    if (this.stopped)
      return Promise.reject(new Error('Speaker extractor stopped'))
    if (signal?.aborted)
      return Promise.reject(new Error('Speaker extraction cancelled'))
    if (this.queue.length >= MAX_QUEUED_EXTRACTIONS)
      return Promise.reject(new Error('Speaker extraction queue full'))
    if (this.backingOff)
      return Promise.reject(this.failure)
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
    if (this.draining || this.stopped)
      return
    this.draining = true
    try {
      while (this.queue.length > 0 && !this.stopped) {
        const job = this.queue.shift()!
        job.signal?.removeEventListener('abort', job.onAbort)
        if (job.measurements)
          job.measurements.queueWaitMs = performance.now() - job.queuedAt
        try {
          const result = await this.run(job.request, job.signal, job.measurements)
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

  private async run(request: SpeakerRequest, signal: AbortSignal | undefined, measurements: SpeakerRecognitionMeasurements | undefined): Promise<SpeakerResult> {
    const samples = request.operation === 'extract' ? request.samples.length : 0
    // An idle recycle or an earlier cancellation may still be closing.
    if (this.process?.retiring)
      await this.process.closed
    // A large dynamic-shape run can grow an already-warm arena past the hard
    // limit. Give long recordings a fresh process, still using the full audio.
    if (this.process && speakerRequiredMemory(samples) >= SPEAKER_RECYCLE_RSS)
      await this.retire(this.process)
    if (this.stopped)
      throw new Error('Speaker extractor stopped')
    if (signal?.aborted)
      throw new Error('Speaker extraction cancelled')
    if (this.failure && this.backingOff)
      throw this.failure
    let budget: number
    try {
      const resident = this.process
      const rss = resident ? this.readRss(resident) : 0
      // Add back the existing worker's RSS: this is a total worker budget,
      // not an additional allocation on top of a second model.
      budget = speakerMemoryBudget(rss)
      if (rss > budget || budget < speakerRequiredMemory(samples))
        throw new Error('Speaker extraction insufficient memory')
    }
    catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      this.backoff(failure)
      if (this.process)
        await this.retire(this.process)
      throw failure
    }
    this.failure = undefined
    const started = performance.now()
    const worker = this.process ?? this.spawn()
    clearTimeout(worker.idleTimer)
    delete worker.idleTimer
    return new Promise((resolve, reject) => {
      const onAbort = () => this.fail(worker, new Error('Speaker extraction cancelled'), false)
      const task: RunningExtraction = {
        id: ++this.nextRequestId,
        request,
        started,
        cold: !worker.started,
        budget,
        measurements,
        signal,
        onAbort,
        timeout: setTimeout(() => this.fail(worker, new Error('Speaker extraction timed out')), EXTRACTION_TIMEOUT_MS),
        resolve,
        reject,
      }
      worker.active = task
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        worker.child.send({ ...request, requestId: task.id }, error => error && this.fail(worker, error))
      }
      catch (error) { this.fail(worker, error instanceof Error ? error : new Error(String(error))) }
    })
  }

  private spawn(): SpeakerProcess {
    const child = fork(new URL('./speaker-worker.mjs', import.meta.url), [this.modelFile], {
      execArgv: [],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      // ORT's explicit numThreads controls inference. Keep nested math-library
      // pools at one thread to avoid multiplying the inference thread count.
      env: { ...process.env, OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1', MKL_NUM_THREADS: '1', MALLOC_ARENA_MAX: '2' },
    })
    let closed!: () => void
    const worker: SpeakerProcess = {
      child,
      closed: new Promise<void>((resolve) => { closed = resolve }),
      started: false,
      rss: 0,
      retiring: false,
      lastIdleCheck: 0,
      stderr: '',
      monitor: setInterval(() => this.checkMemory(worker), 50),
    }
    worker.monitor.unref()
    this.process = worker
    child.once('spawn', () => {
      try {
        if (child.pid)
          setPriority(child.pid, 10)
      }
      catch { /* Container CPU limits remain the hard boundary. */ }
    })
    child.stderr?.on('data', (data: Buffer) => {
      worker.stderr = (worker.stderr + data.toString()).slice(-2_000)
    })
    child.on('message', (message: ExtractionMessage) => this.receive(worker, message))
    child.on('error', error => this.fail(worker, error))
    child.once('close', (code, exitSignal) => {
      clearInterval(worker.monitor)
      clearTimeout(worker.idleTimer)
      if (!worker.retiring) {
        const error = new Error(`Speaker process exited (${exitSignal ?? code}): ${worker.stderr}`)
        if (worker.active)
          worker.active.failure = error
        this.backoff(error)
      }
      if (this.process === worker)
        this.process = undefined
      closed()
      this.finish(worker)
    })
    return worker
  }

  private receive(worker: SpeakerProcess, message: ExtractionMessage): void {
    const task = worker.active
    if (!task || worker.retiring)
      return
    if (message.requestId !== task.id) {
      this.fail(worker, new Error('Invalid speaker process request'))
      return
    }
    const measurements = task.measurements
    if (message.event === 'started') {
      if (measurements && task.cold)
        measurements.processStartupMs = performance.now() - task.started
      return
    }
    if (message.event === 'stageStarted' || message.event === 'stageCompleted') {
      const stage = SPEAKER_WORKER_MEASUREMENT_STAGES.find(stage => stage === message.stage)
      if (!stage) {
        this.fail(worker, new Error('Invalid speaker measurement stage'))
        return
      }
      if (message.event === 'stageStarted') {
        task.activeStage = { stage, started: performance.now() }
      }
      else {
        if (typeof message.durationMs !== 'number' || !Number.isFinite(message.durationMs) || message.durationMs < 0) {
          this.fail(worker, new Error('Invalid speaker measurement duration'))
          return
        }
        if (measurements)
          measurements[stage] = message.durationMs
        delete task.activeStage
      }
      return
    }
    if (typeof message.rss !== 'number' || !Number.isFinite(message.rss) || message.rss <= 0) {
      this.fail(worker, new Error('Invalid speaker process memory usage'))
      return
    }
    worker.rss = message.rss
    try {
      if (worker.rss > Math.min(task.budget, speakerMemoryBudget(worker.rss))) {
        this.fail(worker, new Error('Speaker extraction resource limit exceeded'))
        return
      }
    }
    catch (error) {
      this.fail(worker, error instanceof Error ? error : new Error(String(error)))
      return
    }
    if (message.error) {
      this.fail(worker, new Error(message.error))
      return
    }
    if (message.version !== SPEAKER_VERSION) {
      this.fail(worker, new Error('Invalid speaker process version'))
      return
    }
    if (task.request.operation === 'references' && validReferenceScores(message.scores, task.request.groups)) {
      task.result = message.scores
    }
    else if (task.request.operation === 'extract' && message.status === 'unavailable' && !message.embedding && typeof message.reason === 'string' && message.reason.length > 0) {
      task.result = { status: 'unavailable', version: SPEAKER_VERSION, reason: message.reason }
    }
    else if (task.request.operation === 'extract' && message.embedding instanceof Float32Array && validEmbedding(message.embedding)) {
      task.result = { status: 'ready', version: SPEAKER_VERSION, embedding: message.embedding }
    }
    else {
      this.fail(worker, new Error('Invalid speaker process result'))
      return
    }
    worker.started = true
    if (worker.rss >= Math.min(SPEAKER_RECYCLE_RSS, task.budget * 0.75)) {
      task.terminationRequested = performance.now()
      void this.retire(worker)
      // Return a successful result only after reclaiming the old process.
    }
    else {
      this.finish(worker)
      worker.idleTimer = setTimeout(() => {
        void this.retire(worker)
      }, SPEAKER_IDLE_TIMEOUT_MS)
      worker.idleTimer.unref()
    }
  }

  private readRss(worker: SpeakerProcess): number {
    if (worker.child.pid)
      worker.rss = speakerProcessRss(worker.child.pid) ?? worker.rss
    return worker.rss
  }

  private checkMemory(worker: SpeakerProcess): void {
    if (worker.retiring)
      return
    // Idle workers need supervision too, but not 20 /proc reads per second.
    if (!worker.active) {
      if (Date.now() - worker.lastIdleCheck < 1000)
        return
      worker.lastIdleCheck = Date.now()
    }
    try {
      const rss = this.readRss(worker)
      const budget = Math.min(worker.active?.budget ?? Infinity, speakerMemoryBudget(rss))
      if (rss > budget)
        this.fail(worker, new Error(`Speaker extraction resource limit exceeded (RSS ${Math.ceil(rss / 1048576)} MiB, budget ${Math.floor(budget / 1048576)} MiB)`), Boolean(worker.active))
    }
    catch (error) { this.fail(worker, error instanceof Error ? error : new Error(String(error)), Boolean(worker.active)) }
  }

  private fail(worker: SpeakerProcess, error: Error, backoff = true): void {
    if (worker.retiring)
      return
    if (worker.active) {
      worker.active.failure = error
      worker.active.terminationRequested = performance.now()
    }
    if (backoff)
      this.backoff(error)
    void this.retire(worker)
  }

  private retire(worker: SpeakerProcess): Promise<void> {
    if (!worker.retiring) {
      worker.retiring = true
      clearTimeout(worker.idleTimer)
      worker.child.kill('SIGKILL')
    }
    return worker.closed
  }

  private finish(worker: SpeakerProcess): void {
    const task = worker.active
    if (!task)
      return
    delete worker.active
    clearTimeout(task.timeout)
    task.signal?.removeEventListener('abort', task.onAbort)
    if (task.measurements) {
      const ended = performance.now()
      task.measurements.processTotalMs = ended - task.started
      if (task.terminationRequested !== undefined)
        task.measurements.processExitMs = ended - task.terminationRequested
      if (task.activeStage)
        task.measurements[task.activeStage.stage] = (task.terminationRequested ?? ended) - task.activeStage.started
    }
    if (task.failure)
      task.reject(task.failure)
    else
      task.resolve(task.result!)
  }

  stop(): void {
    this.stopped = true
    this.rejectQueued(new Error('Speaker extractor stopped'))
    if (this.process) {
      if (this.process.active && !this.process.active.result)
        this.fail(this.process, new Error('Speaker extractor stopped'), false)
      else
        void this.retire(this.process)
    }
  }

  private rejectQueued(error: Error): void {
    for (const job of this.queue.splice(0)) {
      if (job.measurements)
        job.measurements.queueWaitMs = performance.now() - job.queuedAt
      job.signal?.removeEventListener('abort', job.onAbort)
      job.reject(error)
    }
  }

  private backoff(error: Error): void {
    this.failure = error
    this.retryAt = Date.now() + RETRY_DELAY_MS
  }
}

function validReferenceScores(scores: unknown, groups: SpeakerReferenceGroup[]): scores is SpeakerReferenceScore[] {
  return Array.isArray(scores) && scores.length === groups.length && scores.every((score, index) => {
    if (!score || score.callsign !== groups[index]!.callsign || !Number.isInteger(score.referenceRecordCount)
      || score.referenceRecordCount < 0 || score.referenceRecordCount > Math.min(10, groups[index]!.embeddings.length)) {
      return false
    }
    return score.referenceSimilarity === null
      ? score.referenceRecordCount === 0
      : typeof score.referenceSimilarity === 'number' && Number.isFinite(score.referenceSimilarity)
        && score.referenceSimilarity >= -1 && score.referenceSimilarity <= 1 && score.referenceRecordCount > 0
  })
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
