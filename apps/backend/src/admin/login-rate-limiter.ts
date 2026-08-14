interface AttemptWindow {
  count: number
  resetAt: number
}

export interface LoginRateLimiterOptions {
  maxAttempts?: number
  now?: () => number
  windowMs?: number
}

export class LoginRateLimiter {
  private readonly attempts = new Map<string, AttemptWindow>()
  private readonly maxAttempts: number
  private readonly now: () => number
  private readonly windowMs: number

  constructor(options: LoginRateLimiterOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? 10
    this.now = options.now ?? Date.now
    this.windowMs = options.windowMs ?? 5 * 60_000
  }

  consume(keys: string[]): number | undefined {
    const now = this.now()
    let retryAfterMs = 0
    for (const key of keys) {
      const attempt = this.attempts.get(key)
      if (attempt && attempt.resetAt > now && attempt.count >= this.maxAttempts)
        retryAfterMs = Math.max(retryAfterMs, attempt.resetAt - now)
    }
    if (retryAfterMs > 0)
      return retryAfterMs

    for (const key of keys) {
      const current = this.attempts.get(key)
      if (!current || current.resetAt <= now) {
        this.attempts.set(key, { count: 1, resetAt: now + this.windowMs })
      }
      else {
        current.count++
      }
    }
    return undefined
  }

  reset(keys: string[]): void {
    for (const key of keys)
      this.attempts.delete(key)
  }
}
