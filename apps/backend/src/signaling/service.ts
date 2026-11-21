import type { RadioSignal } from '@iaxweb/contracts'
import { Worker } from 'node:worker_threads'
import { radioSignalsSchema } from '@iaxweb/contracts'
import { signalingWindows } from './decoder.mjs'

interface Job {
  windows: Int16Array[]
  expiresAt: number
  resolve: (value: readonly RadioSignal[] | null) => void
}

// One CPU worker for all nodes, independent of the ASR/LLM queues. Failed or
// overloaded jobs resolve to null; they can never block the audio relay.
export class SignalingService {
  private worker: Worker | undefined
  private active: Job | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly pending: Job[] = []
  private stopped = false

  decode(pcm: Int16Array): Promise<readonly RadioSignal[] | null> {
    if (this.stopped || this.pending.length >= 8 || pcm.length > 8_000 * 300)
      return Promise.resolve(null)
    let windows: Int16Array[]
    try {
      windows = signalingWindows(pcm)
    }
    catch {
      return Promise.resolve(null)
    }
    return new Promise((resolve) => {
      this.pending.push({ windows, expiresAt: Date.now() + 30_000, resolve })
      this.drain()
    })
  }

  stop(): void {
    this.stopped = true
    for (const job of this.pending.splice(0)) job.resolve(null)
    this.recycle()
  }

  private drain(): void {
    if (this.stopped || this.active)
      return
    let job = this.pending.shift()
    while (job && job.expiresAt < Date.now()) {
      job.resolve(null)
      job = this.pending.shift()
    }
    if (!job)
      return
    this.active = job
    try {
      if (!this.worker) {
        const worker = new Worker(new URL('./worker.mjs', import.meta.url), {
          resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
        })
        this.worker = worker
        worker.on('message', (message: unknown) => {
          if (this.worker !== worker)
            return
          const parsed = radioSignalsSchema.safeParse(message)
          this.finish(parsed.success ? parsed.data : null)
        })
        worker.on('error', () => {
          if (this.worker === worker)
            this.recycle()
        })
        worker.on('exit', () => {
          if (this.worker === worker)
            this.recycle()
        })
      }
      this.timer = setTimeout(() => this.recycle(), 10_000)
      this.worker.ref()
      this.worker.postMessage(job.windows)
    }
    catch {
      this.recycle()
    }
  }

  private finish(result: readonly RadioSignal[] | null): void {
    clearTimeout(this.timer)
    this.timer = undefined
    const job = this.active
    this.active = undefined
    this.worker?.unref()
    job?.resolve(result)
    this.drain()
  }

  private recycle(): void {
    const worker = this.worker
    this.worker = undefined
    void worker?.terminate().catch(() => {})
    this.finish(null)
  }
}
