import type { SpeakerRecognitionMeasurements } from '@iaxweb/contracts'
import type { Buffer } from 'node:buffer'
import type { ChildProcess } from 'node:child_process'
import type { SpeakerWorkerMeasurementStage } from './speaker-measurements.js'
import type { SpeakerRequest, SpeakerResult, SpeakerWorkerMessage } from './speaker-protocol.js'
import { fork } from 'node:child_process'
import { setPriority } from 'node:os'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { SPEAKER_WORKER_MEASUREMENT_STAGES } from './speaker-measurements.js'
import { SPEAKER_VERSION } from './speaker-model.mjs'
import { parseSpeakerResult } from './speaker-protocol.js'
import { SPEAKER_IDLE_TIMEOUT_MS, SPEAKER_RECYCLE_RSS, speakerMemoryBudget, speakerProcessRss, speakerRequiredMemory } from './speaker-resources.js'

const EXTRACTION_TIMEOUT_MS = 60_000
const RETRY_DELAY_MS = 60_000

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

// Recycling waits for close before starting another model, including after
// timeout or cancellation. The extractor serializes calls to run().
export class SpeakerWorkerProcess {
  private process: SpeakerProcess | undefined
  private nextRequestId = 0
  private failure: Error | undefined
  private retryAt = 0
  private stopping = false

  constructor(private readonly modelFile: string) {}

  get stopped(): boolean {
    return this.stopping
  }

  get backoffError(): Error | undefined {
    return this.failure && Date.now() < this.retryAt ? this.failure : undefined
  }

  async run(request: SpeakerRequest, signal: AbortSignal | undefined, measurements: SpeakerRecognitionMeasurements | undefined): Promise<SpeakerResult> {
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
    const backoffError = this.backoffError
    if (backoffError)
      throw backoffError
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
    child.on('message', (message: SpeakerWorkerMessage) => this.receive(worker, message))
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

  private receive(worker: SpeakerProcess, message: SpeakerWorkerMessage): void {
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
    const result = parseSpeakerResult(task.request, message)
    if (!result) {
      this.fail(worker, new Error('Invalid speaker process result'))
      return
    }
    task.result = result
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
    this.stopping = true
    if (this.process) {
      if (this.process.active && !this.process.active.result)
        this.fail(this.process, new Error('Speaker extractor stopped'), false)
      else
        void this.retire(this.process)
    }
  }

  private backoff(error: Error): void {
    this.failure = error
    this.retryAt = Date.now() + RETRY_DELAY_MS
  }
}
