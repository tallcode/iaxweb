// Strictly serial job queue. Serial execution matters here: each ASR request
// feeds its transcript into the context of the next one, so concurrent calls
// would interleave the context.
export class SerialQueue {
  private jobs: Array<() => Promise<void>> = []
  private draining = false

  constructor(
    private readonly maxDepth: number,
    private readonly onOverflow?: () => void,
  ) {}

  get pending(): number {
    return this.jobs.length
  }

  add(job: () => Promise<void>): void {
    if (this.jobs.length >= this.maxDepth) {
      this.jobs.shift()
      this.onOverflow?.()
    }
    this.jobs.push(job)
    void this.drain()
  }

  clear(): void {
    this.jobs.length = 0
  }

  private async drain(): Promise<void> {
    if (this.draining)
      return
    this.draining = true
    try {
      while (this.jobs.length > 0) {
        const job = this.jobs.shift()
        if (!job)
          break
        try {
          await job()
        }
        catch {
          // Jobs report their own errors; keep the queue moving.
        }
      }
    }
    finally {
      this.draining = false
    }
  }
}
