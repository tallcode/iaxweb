import type { StatusSnapshot } from './types.js'

interface TimerScheduler {
  clear: (timer: unknown) => void
  set: (callback: () => void, delayMs: number) => unknown
}

const defaultScheduler: TimerScheduler = {
  clear: timer => clearTimeout(timer as NodeJS.Timeout),
  set: (callback, delayMs) => setTimeout(callback, delayMs),
}

export class SnapshotNotifier {
  private readonly delayMs: number
  private readonly notify: (snapshot: StatusSnapshot) => void
  private readonly scheduler: TimerScheduler
  private pendingSnapshot: StatusSnapshot | undefined
  private timer: unknown | undefined

  constructor(
    notify: (snapshot: StatusSnapshot) => void,
    delayMs = 200,
    scheduler: TimerScheduler = defaultScheduler,
  ) {
    this.notify = notify
    this.delayMs = delayMs
    this.scheduler = scheduler
  }

  schedule(snapshot: StatusSnapshot): void {
    this.pendingSnapshot = snapshot
    if (this.timer !== undefined)
      return

    this.timer = this.scheduler.set(() => {
      this.timer = undefined
      const pendingSnapshot = this.pendingSnapshot
      this.pendingSnapshot = undefined
      if (pendingSnapshot)
        this.notify(pendingSnapshot)
    }, this.delayMs)
  }

  stop(): void {
    if (this.timer !== undefined)
      this.scheduler.clear(this.timer)
    this.timer = undefined
    this.pendingSnapshot = undefined
  }
}
