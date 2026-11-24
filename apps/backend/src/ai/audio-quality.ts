import type { AudioQuality } from '@iaxweb/contracts'
import { Worker } from 'node:worker_threads'
import { audioQualitySchema } from '@iaxweb/contracts'

interface Job {
  samples: Float32Array
  gateVersion: AudioQuality['gateVersion']
  resolve: (quality: AudioQuality) => void
  signal: AbortSignal | undefined
  onAbort: () => void
  timeout: ReturnType<typeof setTimeout>
}

export function unknownAudioQuality(reason: string, gateVersion?: AudioQuality['gateVersion']): AudioQuality {
  return gateVersion === undefined
    ? { status: 'unknown', reason, metrics: null }
    : { status: 'unknown', reason, metrics: null, gateVersion }
}

// Independent of the native speaker process and model availability. One shared
// CPU worker, bounded jobs and deadlines; failure never counts as a pass.
export class AudioQualityService {
  private worker: Worker | undefined
  private active: Job | undefined
  private readonly pending: Job[] = []
  private stopped = false

  // An unversioned recording retains the original rules on explicit retries.
  check(samples: Float32Array, signal?: AbortSignal, gateVersion?: AudioQuality['gateVersion']): Promise<AudioQuality> {
    if (this.stopped || signal?.aborted)
      return Promise.resolve(unknownAudioQuality('check_cancelled', gateVersion))
    if (samples.length > 8_000 * 300)
      return Promise.resolve(unknownAudioQuality('check_audio_too_long', gateVersion))
    if (this.pending.length >= 10)
      return Promise.resolve(unknownAudioQuality('check_busy', gateVersion))
    return new Promise<AudioQuality>((resolve) => {
      const job: Job = {
        samples: Float32Array.from(samples),
        gateVersion,
        resolve,
        signal,
        onAbort: () => this.cancel(job, 'check_cancelled'),
        timeout: setTimeout(() => this.cancel(job, 'check_timeout'), 10_000),
      }
      signal?.addEventListener('abort', job.onAbort, { once: true })
      this.pending.push(job)
      this.drain()
    }).catch(() => unknownAudioQuality('check_failed', gateVersion))
  }

  stop(): void {
    this.stopped = true
    for (const job of this.pending.splice(0)) this.settle(job, unknownAudioQuality('check_cancelled'))
    this.recycle('check_cancelled')
  }

  private settle(job: Job, quality: AudioQuality): void {
    clearTimeout(job.timeout)
    job.signal?.removeEventListener('abort', job.onAbort)
    job.resolve(job.gateVersion === undefined ? quality : { ...quality, gateVersion: job.gateVersion })
  }

  private cancel(job: Job, reason: string): void {
    if (this.active === job) {
      this.recycle(reason)
      return
    }
    const index = this.pending.indexOf(job)
    if (index >= 0) {
      this.pending.splice(index, 1)
      this.settle(job, unknownAudioQuality(reason))
    }
  }

  private drain(): void {
    if (this.stopped || this.active)
      return
    const job = this.pending.shift()
    if (!job)
      return
    this.active = job
    try {
      if (!this.worker) {
        const worker = new Worker(new URL('./audio-quality-worker.mjs', import.meta.url), {
          resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
        })
        this.worker = worker
        worker.on('message', (message: unknown) => {
          if (this.worker !== worker)
            return
          const parsed = audioQualitySchema.safeParse(message)
          this.finish(parsed.success ? parsed.data : unknownAudioQuality('check_failed'))
        })
        worker.on('error', () => this.worker === worker && this.recycle('check_failed'))
        worker.on('exit', () => this.worker === worker && this.recycle('check_failed'))
      }
      this.worker.ref()
      this.worker.postMessage({ samples: job.samples, legacy: job.gateVersion === undefined })
    }
    catch { this.recycle('check_failed') }
  }

  private finish(quality: AudioQuality): void {
    const job = this.active
    this.active = undefined
    this.worker?.unref()
    if (job)
      this.settle(job, quality)
    this.drain()
  }

  private recycle(reason: string): void {
    const worker = this.worker
    this.worker = undefined
    void worker?.terminate().catch(() => {})
    this.finish(unknownAudioQuality(reason))
  }
}
