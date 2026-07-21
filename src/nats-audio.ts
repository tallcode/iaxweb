import type { NatsConnection, Subscription } from '@nats-io/transport-node'
import type { Config } from './config.js'
import { randomUUID } from 'node:crypto'
import { connect, RequestError, TimeoutError } from '@nats-io/transport-node'

export interface StateEvent {
  type: 'state'
  online: boolean
  speaking: boolean
  listeners?: number
}

interface NatsAudioOptions {
  config: Config['nats']
  nodeId: string
  onAudio: (data: Uint8Array) => void
  onEvent: (text: string) => void
  onState: (state: StateEvent) => void
  retryIntervalMs?: number
}

const offlineState: StateEvent = { type: 'state', online: false, speaking: false }
const listenerHeartbeatMs = 15_000

export class NatsAudioService {
  private readonly config: Config['nats']
  private readonly onAudio: (data: Uint8Array) => void
  private readonly onEvent: (text: string) => void
  private readonly onState: (state: StateEvent) => void
  private readonly retryIntervalMs: number
  private readonly subjectPrefix: string
  private connection: NatsConnection | undefined
  private retryTimer: NodeJS.Timeout | undefined
  private heartbeatTimer: NodeJS.Timeout | undefined
  private retryAttempt = 0
  private stopped = true
  private transportConnected = false
  private state: StateEvent = offlineState
  private readonly gatewayId = randomUUID()
  private listenerCount = 0

  constructor(options: NatsAudioOptions) {
    this.config = options.config
    this.subjectPrefix = `${options.config.subjectRoot}.${options.nodeId}`
    this.onAudio = options.onAudio
    this.onEvent = options.onEvent
    this.onState = options.onState
    this.retryIntervalMs = options.retryIntervalMs ?? 5_000
  }

  get currentState(): StateEvent {
    return this.state
  }

  get connected(): boolean {
    return this.transportConnected
  }

  start(): void {
    if (!this.stopped)
      return
    this.stopped = false
    this.heartbeatTimer = setInterval(() => this.publishListeners(), listenerHeartbeatMs)
    this.heartbeatTimer.unref()
    void this.connectOnce()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.retryTimer)
      clearTimeout(this.retryTimer)
    if (this.heartbeatTimer)
      clearInterval(this.heartbeatTimer)
    this.retryTimer = undefined
    this.heartbeatTimer = undefined
    const connection = this.connection
    this.connection = undefined
    this.listenerCount = 0
    if (connection) {
      this.publishListeners(connection)
      await connection.flush()
    }
    this.transportConnected = false
    await connection?.drain()
  }

  setListenerCount(count: number): void {
    const next = Math.max(0, Math.trunc(count))
    if (next === this.listenerCount)
      return
    this.listenerCount = next
    this.publishListeners()
  }

  private async connectOnce(): Promise<void> {
    try {
      const connection = await connect({
        servers: this.config.servers,
        ...(this.config.username
          ? { user: this.config.username, pass: this.config.password }
          : {}),
        ...(this.config.token ? { token: this.config.token } : {}),
        name: 'iaxweb',
        maxReconnectAttempts: -1,
      })
      if (this.stopped) {
        await connection.close()
        return
      }

      this.connection = connection
      this.retryAttempt = 0
      this.transportConnected = true
      const prefix = this.subjectPrefix
      void this.relayAudio(connection.subscribe(`${prefix}.audio`))
      void this.relayEvents(connection.subscribe(`${prefix}.events`))
      void this.watchConnection(connection)
      await connection.flush()
      this.publishListeners(connection)
      await this.requestSnapshot(connection)
    }
    catch (error) {
      console.warn('NATS connection unavailable; audio will retry:', errorMessage(error))
      this.scheduleRetry()
    }
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer)
      return
    const delay = Math.min(30_000, this.retryIntervalMs * 2 ** Math.min(this.retryAttempt, 3))
    this.retryAttempt++
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      void this.connectOnce()
    }, delay)
  }

  private async relayAudio(subscription: Subscription): Promise<void> {
    for await (const message of subscription)
      this.onAudio(message.data)
  }

  private async relayEvents(subscription: Subscription): Promise<void> {
    for await (const message of subscription) {
      const text = new TextDecoder().decode(message.data)
      try {
        const event = JSON.parse(text) as unknown
        if (isStateEvent(event))
          this.setState(event)
        else
          this.onEvent(text)
      }
      catch (error) {
        console.warn('Ignoring invalid NATS event:', error)
      }
    }
  }

  private async requestSnapshot(connection: NatsConnection): Promise<void> {
    const subject = `${this.subjectPrefix}.snapshot`
    try {
      const reply = await connection.request(subject, undefined, { timeout: 2_000 })
      const state = JSON.parse(new TextDecoder().decode(reply.data)) as unknown
      if (isStateEvent(state))
        this.setState(state)
    }
    catch (error) {
      if ((error instanceof RequestError && error.isNoResponders()) || error instanceof TimeoutError) {
        console.warn(`NATS snapshot responder is unavailable on ${subject}; continuing offline`)
        return
      }
      console.warn('Failed to read NATS state snapshot:', error)
    }
  }

  private async watchConnection(connection: NatsConnection): Promise<void> {
    for await (const status of connection.status()) {
      console.log(`NATS ${status.type}`, status)

      if (status.type === 'disconnect') {
        this.transportConnected = false
        this.setState(offlineState)
      }
      else if (status.type === 'reconnect') {
        this.transportConnected = true
        this.publishListeners(connection)
        await this.requestSnapshot(connection)
      }
    }

    if (this.connection === connection)
      this.connection = undefined
    if (!this.stopped) {
      this.transportConnected = false
      this.setState(offlineState)
      this.scheduleRetry()
    }
  }

  private setState(state: StateEvent): void {
    this.state = state
    this.onState(state)
  }

  private publishListeners(connection = this.connection): void {
    if (!connection || !this.transportConnected)
      return
    const subject = `${this.subjectPrefix}.listeners`
    const payload = JSON.stringify({
      type: 'listeners',
      gateway_id: this.gatewayId,
      count: this.listenerCount,
    })
    try {
      connection.publish(subject, new TextEncoder().encode(payload))
    }
    catch (error) {
      console.warn('Failed to publish listener count:', error)
    }
  }
}

export function isStateEvent(value: unknown): value is StateEvent {
  if (typeof value !== 'object' || value === null)
    return false
  const event = value as Record<string, unknown>
  return event.type === 'state'
    && typeof event.online === 'boolean'
    && typeof event.speaking === 'boolean'
    && (event.listeners === undefined || (Number.isInteger(event.listeners) && (event.listeners as number) >= 0))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
