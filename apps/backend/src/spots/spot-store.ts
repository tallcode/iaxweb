import type { SpotEvent } from '@iaxweb/contracts'
import type { NatsConnection, Subscription } from '@nats-io/transport-node'
import { isDisplayableCallsign, NO_CALLSIGN, spotEventSchema } from '@iaxweb/contracts'

export { isDisplayableCallsign, isValidCallsign, NO_CALLSIGN } from '@iaxweb/contracts'

export type { SpotEvent } from '@iaxweb/contracts'

export interface SpotStoreOptions {
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
  createConnection: () => Promise<NatsConnection>
  retryDelayMs?: number
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
  subjectPrefix?: string
}

// Core-NATS-only live Spot relay. Historical spots are read from SQLite by
// RecordRepository, so NATS never acts as a second persistent data store.
export class SpotStore {
  private readonly createConnection: () => Promise<NatsConnection>
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void
  private readonly retryDelayMs: number
  private readonly setTimer: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
  private readonly subjectPrefix: string
  private connection: NatsConnection | undefined
  private onSpot: ((spot: SpotEvent) => void) | undefined
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private stopped = true
  private subscription: Subscription | undefined

  constructor(options: SpotStoreOptions) {
    this.createConnection = options.createConnection
    this.clearTimer = options.clearTimer ?? (timer => clearTimeout(timer))
    this.retryDelayMs = options.retryDelayMs ?? 5_000
    this.setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay))
    this.subjectPrefix = options.subjectPrefix ?? 'iaxmon.nodes'
  }

  async start(onSpot: (spot: SpotEvent) => void): Promise<void> {
    if (!this.stopped)
      return
    this.stopped = false
    this.onSpot = onSpot
    await this.connectOnce()
  }

  private async connectOnce(): Promise<void> {
    if (this.stopped || this.connection)
      return
    try {
      const connection = await this.createConnection()
      if (this.stopped) {
        await connection.close()
        return
      }
      this.connection = connection
      this.subscription = connection.subscribe(`${this.subjectPrefix}.*.ai.spot.*`)
      void this.consume(this.subscription, this.onSpot)
      void this.watchConnection(connection)
    }
    catch (error) {
      console.warn(`[AI] Core NATS spot relay unavailable: ${errorMessage(error)}`)
      this.scheduleRetry()
    }
  }

  publish(spot: SpotEvent): void {
    if (!isDisplayableCallsign(spot.callsign))
      return
    this.send(spot)
  }

  // Review events may set N0CALL to remove this record's live spot.
  publishReview(spot: SpotEvent): void {
    if (!isDisplayableCallsign(spot.callsign) && spot.callsign !== NO_CALLSIGN)
      return
    this.send(spot)
  }

  private send(spot: SpotEvent): void {
    try {
      this.connection?.publish(this.subject(spot), JSON.stringify({ ...spot, source: spot.source ?? null }))
    }
    catch (error) {
      console.warn(`[AI] spot 发布失败: ${errorMessage(error)}`)
    }
  }

  async close(): Promise<void> {
    this.stopped = true
    this.onSpot = undefined
    if (this.retryTimer)
      this.clearTimer(this.retryTimer)
    this.retryTimer = undefined
    this.subscription?.unsubscribe()
    this.subscription = undefined
    const connection = this.connection
    this.connection = undefined
    await connection?.drain()
  }

  private async consume(subscription: Subscription, onSpot: ((spot: SpotEvent) => void) | undefined): Promise<void> {
    try {
      for await (const message of subscription) {
        const spot = parseSpot(message.data)
        if (spot)
          onSpot?.(spot)
      }
    }
    catch (error) {
      if (!this.stopped)
        console.warn(`[AI] Core NATS spot subscription ended: ${errorMessage(error)}`)
    }
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer)
      return
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = undefined
      void this.connectOnce()
    }, this.retryDelayMs)
  }

  private async watchConnection(connection: NatsConnection): Promise<void> {
    const error = await connection.closed()
    if (this.connection !== connection)
      return
    this.connection = undefined
    this.subscription = undefined
    if (!this.stopped) {
      if (error)
        console.warn(`[AI] Core NATS spot connection closed: ${errorMessage(error)}`)
      this.scheduleRetry()
    }
  }

  private subject(spot: SpotEvent): string {
    return `${this.subjectPrefix}.${spot.node}.ai.spot.${spot.callsign}`
  }
}

function parseSpot(data: Uint8Array): SpotEvent | undefined {
  try {
    const parsed = spotEventSchema.safeParse(JSON.parse(new TextDecoder().decode(data)))
    return parsed.success ? parsed.data : undefined
  }
  catch {
    return undefined
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
