import type { NatsConnection, Subscription } from '@nats-io/transport-node'

export interface SpotEvent {
  at: string
  callsign: string
  id: string
  node: string
}

export interface SpotStoreOptions {
  createConnection: () => Promise<NatsConnection>
  subjectPrefix?: string
}

const CALLSIGN_PATTERN = /^B[ADGHIY]\d[A-Z]{2,3}$/
export const NO_CALLSIGN = 'N0CALL'

// Core-NATS-only live Spot relay. Historical spots are read from SQLite by
// SegmentRepository, so NATS never acts as a second persistent data store.
export class SpotStore {
  private readonly createConnection: () => Promise<NatsConnection>
  private readonly subjectPrefix: string
  private connection: NatsConnection | undefined
  private subscription: Subscription | undefined

  constructor(options: SpotStoreOptions) {
    this.createConnection = options.createConnection
    this.subjectPrefix = options.subjectPrefix ?? 'iaxmon.nodes'
  }

  async start(onSpot: (spot: SpotEvent) => void): Promise<void> {
    try {
      this.connection = await this.createConnection()
      this.subscription = this.connection.subscribe(`${this.subjectPrefix}.*.ai.spot.*`)
      void this.consume(this.subscription, onSpot)
    }
    catch (error) {
      console.warn(`[AI] Core NATS spot relay unavailable: ${errorMessage(error)}`)
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
      this.connection?.publish(this.subject(spot), JSON.stringify(spot))
    }
    catch (error) {
      console.warn(`[AI] spot 发布失败: ${errorMessage(error)}`)
    }
  }

  async close(): Promise<void> {
    this.subscription?.unsubscribe()
    this.subscription = undefined
    const connection = this.connection
    this.connection = undefined
    await connection?.drain()
  }

  private async consume(subscription: Subscription, onSpot: (spot: SpotEvent) => void): Promise<void> {
    for await (const message of subscription) {
      const spot = parseSpot(message.data)
      if (spot)
        onSpot(spot)
    }
  }

  private subject(spot: SpotEvent): string {
    return `${this.subjectPrefix}.${spot.node}.ai.spot.${spot.callsign}`
  }
}

export function isDisplayableCallsign(value: string): boolean {
  return value !== NO_CALLSIGN && CALLSIGN_PATTERN.test(value)
}

// Used by callsign hints to validate ordinary amateur-radio callsigns. N0CALL
// is a manual-review sentinel and intentionally does not pass this check.
export const isValidCallsign = isDisplayableCallsign

function parseSpot(data: Uint8Array): SpotEvent | undefined {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>
    if (typeof parsed.callsign !== 'string' || (!isDisplayableCallsign(parsed.callsign) && parsed.callsign !== NO_CALLSIGN)
      || typeof parsed.node !== 'string' || typeof parsed.id !== 'string' || typeof parsed.at !== 'string') {
      return undefined
    }
    return {
      at: parsed.at,
      callsign: parsed.callsign,
      id: parsed.id,
      node: parsed.node,
    }
  }
  catch {
    return undefined
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
