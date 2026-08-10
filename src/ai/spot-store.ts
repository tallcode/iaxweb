import type { NatsConnection } from '@nats-io/transport-node'
import { jetstream, jetstreamManager } from '@nats-io/jetstream'

export interface SpotEvent {
  callsign: string
  node: string
  segmentId: string
  at: string
}

export type SpotRecordResult = 'published' | 'rejected' | 'stored'

const CALLSIGN_PATTERN = /^B[ADGHIY]\d[A-Z]{2,3}$/

// Structural views of the JetStream API surface this store uses, so tests can
// inject fakes without dragging in the real client types.
export interface StreamsLike {
  add: (cfg: Record<string, unknown>) => Promise<unknown>
  info: (name: string) => Promise<{ state: { messages: number } }>
}
export interface ManagerConsumersLike {
  add: (stream: string, cfg: Record<string, unknown>) => Promise<{ name: string }>
}
export interface JetStreamManagerLike {
  consumers: ManagerConsumersLike
  streams: StreamsLike
}
export interface ConsumersLike {
  get: (stream: string, name: string) => Promise<{
    fetch: (opts?: Record<string, unknown>) => Promise<AsyncIterable<{ data: Uint8Array }> & { close: () => Promise<void> | void }>
    consume: (opts?: Record<string, unknown>) => Promise<AsyncIterable<{ data: Uint8Array }> & { close: () => Promise<void> | void }>
  }>
}
export interface JetStreamLike {
  consumers: ConsumersLike
  publish: (subject: string, data: string | Uint8Array) => Promise<unknown>
}

export interface SpotStoreOptions {
  createConnection: () => Promise<NatsConnection>
  streamName?: string
  subjectPrefix?: string
  now?: () => number
  // Injectable for tests; production uses the real JetStream client.
  jetstreamManagerImpl?: (connection: NatsConnection) => Promise<JetStreamManagerLike>
  jetstreamImpl?: (connection: NatsConnection) => JetStreamLike
}

const SPOT_TTL_NS = 24 * 60 * 60 * 1_000_000_000

// JetStream-backed record of recognized callsigns. The stream keeps at most
// one message per subject, and each callsign is a subject, so history holds
// exactly the newest spot per callsign within 24 h. Reads are served from an
// in-memory map warmed from the stream at startup; without JetStream the
// gateway degrades to a session-only view.
export class SpotStore {
  private readonly options: SpotStoreOptions
  private readonly streamName: string
  private readonly subjectPrefix: string
  private readonly now: () => number
  private readonly managerImpl: (connection: NatsConnection) => Promise<JetStreamManagerLike>
  private readonly jsImpl: (connection: NatsConnection) => JetStreamLike
  private readonly spots = new Map<string, SpotEvent>()
  private connection: NatsConnection | undefined
  private available = false
  private started: Promise<void> | undefined
  private lastSeq = 0

  constructor(options: SpotStoreOptions) {
    this.options = options
    this.streamName = options.streamName ?? 'AI_SPOT'
    this.subjectPrefix = options.subjectPrefix ?? 'iaxmon.nodes'
    this.now = options.now ?? Date.now
    this.managerImpl = options.jetstreamManagerImpl ?? (connection => jetstreamManager(connection) as unknown as Promise<JetStreamManagerLike>)
    this.jsImpl = options.jetstreamImpl ?? (connection => jetstream(connection) as unknown as JetStreamLike)
  }

  get isAvailable(): boolean {
    return this.available
  }

  async start(): Promise<void> {
    if (!this.started) {
      // Bound the whole init so a down NATS server cannot hang /api/spots.
      const timedOut = sleep(15_000).then(() => {
        throw new Error('JetStream 初始化超时')
      })
      this.started = Promise.race([this.initialize(), timedOut]).catch((error) => {
        console.warn(`[AI] JetStream spot store unavailable: ${errorMessage(error)}`)
        this.available = false
      })
    }
    await this.started
  }

  private async initialize(): Promise<void> {
    this.connection = await this.options.createConnection()
    const manager = await this.managerImpl(this.connection)
    try {
      // Reuse the stream if a previous run created it; streams.add would
      // reject with "name already in use".
      await manager.streams.info(this.streamName)
    }
    catch {
      // `>` must be the last token in a subject, so the node position uses `*`
      // (a single token) and only the callsign tail uses `>`.
      await manager.streams.add({
        name: this.streamName,
        subjects: [`${this.subjectPrefix}.*.ai.spot.>`],
        storage: 'file',
        retention: 'limits',
        max_age: SPOT_TTL_NS,
        max_msgs_per_subject: 1,
      })
    }
    this.available = true
    await this.loadHistory(manager)
  }

  private async loadHistory(manager: JetStreamManagerLike): Promise<void> {
    const connection = this.connection
    if (!connection)
      return
    // Skip the pull fetch entirely when nothing has been stored; an empty
    // pull consumer would otherwise wait for messages past the init timeout.
    const stream = await manager.streams.info(this.streamName)
    if (stream.state.messages === 0)
      return
    // Ephemeral "all history" pull consumer; ack none so the gateway can
    // re-warm its cache on every restart without consuming the stream.
    const info = await manager.consumers.add(this.streamName, {
      deliver_policy: 'all',
      ack_policy: 'none',
      max_waiting: 1,
    })
    const consumer = await this.jsImpl(connection).consumers.get(this.streamName, info.name)
    // A no_wait pull subscription stays open for new messages after the stored
    // ones are delivered, so iterate by the known message count and close it.
    const total = stream.state.messages
    const messages = await consumer.fetch({ max_messages: total, no_wait: true })
    let seen = 0
    for await (const message of messages) {
      const spot = parseSpot(message.data)
      if (spot)
        this.spots.set(spot.callsign, spot)
      seen++
      if (seen >= total)
        break
    }
    await messages.close()
  }

  // Records a spot for live display and (when JetStream is up) persists it.
  async record(spot: SpotEvent): Promise<SpotRecordResult> {
    await this.start()
    if (!isValidCallsign(spot.callsign))
      return 'rejected'
    this.prune()
    this.spots.set(spot.callsign, spot)
    if (!this.available)
      return 'stored'
    try {
      const connection = this.connection
      const subject = this.spotSubject(spot)
      if (!connection || !subject)
        return 'stored'
      await this.jsImpl(connection).publish(subject, JSON.stringify(spot))
      return 'published'
    }
    catch (error) {
      console.warn(`[AI] spot 发布失败: ${errorMessage(error)}`)
      return 'stored'
    }
  }

  // Newest spot per callsign within 24 h, most recent first.
  async recent(): Promise<SpotEvent[]> {
    await this.start()
    this.prune()
    return [...this.spots.values()].sort((a, b) => (a.at < b.at ? 1 : -1))
  }

  // Live feed: every new spot that reaches JetStream (including this
  // gateway's own publishes and any external publisher) is kept in the
  // in-memory view and forwarded to the callback. Runs until the connection
  // closes. Called after start() has loaded the existing history.
  async consume(onSpot: (spot: SpotEvent) => void): Promise<void> {
    const connection = this.connection
    if (!connection)
      return
    try {
      const manager = await this.managerImpl(connection)
      const info = await manager.consumers.add(this.streamName, {
        deliver_policy: 'new',
        ack_policy: 'none',
        max_waiting: 1,
      })
      const consumer = await this.jsImpl(connection).consumers.get(this.streamName, info.name)
      const messages = await consumer.consume()
      for await (const message of messages) {
        const spot = parseSpot(message.data)
        if (!spot)
          continue
        this.spots.set(spot.callsign, spot)
        onSpot(spot)
      }
    }
    catch (error) {
      console.warn(`[AI] spot 订阅中断: ${errorMessage(error)}`)
    }
  }

  async close(): Promise<void> {
    const connection = this.connection
    this.connection = undefined
    if (connection)
      await connection.close()
  }

  private spotSubject(spot: SpotEvent): string {
    // Only publish well-formed callsigns as subject tokens.
    if (!isValidCallsign(spot.callsign))
      return ''
    return `${this.subjectPrefix}.${spot.node}.ai.spot.${spot.callsign}`
  }

  private prune(): void {
    const cutoff = this.now() - 24 * 60 * 60 * 1_000
    for (const [callsign, spot] of this.spots) {
      const at = Date.parse(spot.at)
      if (Number.isNaN(at) || at < cutoff)
        this.spots.delete(callsign)
    }
  }
}

function parseSpot(data: Uint8Array): SpotEvent | undefined {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(data)) as unknown
    if (typeof parsed !== 'object' || parsed === null)
      return undefined
    const spot = parsed as Record<string, unknown>
    if (typeof spot.callsign !== 'string' || !isValidCallsign(spot.callsign) || typeof spot.node !== 'string'
      || typeof spot.segmentId !== 'string' || typeof spot.at !== 'string') {
      return undefined
    }
    return { callsign: spot.callsign, node: spot.node, segmentId: spot.segmentId, at: spot.at }
  }
  catch {
    return undefined
  }
}

export function isValidCallsign(value: string): boolean {
  return CALLSIGN_PATTERN.test(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sleep(ms: number): Promise<void> {
  return new Promise(done => setTimeout(done, ms))
}
