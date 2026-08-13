import type { Allmon3ServiceOptions, NodeConfig, NodeStatus, StatusSnapshot } from './types.js'
import { WebSocket } from 'ws'
import { Allmon3ApiClient } from './api-client.js'
import { mergeNodeConfigs } from './catalog.js'
import { isRecord } from './definitions.js'
import { SnapshotNotifier } from './snapshot-notifier.js'
import { buildSnapshot, statusFingerprint } from './snapshot.js'
import { TransmissionTracker } from './transmission.js'

export class Allmon3StatusService {
  private readonly refreshIntervalMs: number
  private readonly requestTimeoutMs: number
  private readonly notifier: SnapshotNotifier
  private readonly definitions: Allmon3ServiceOptions['nodes']
  private readonly api: Allmon3ApiClient
  private readonly configs = new Map<string, NodeConfig>()
  private readonly details = new Map<string, NodeStatus>()
  private readonly sockets = new Map<number, WebSocket>()
  private readonly reconnectAttempts = new Map<number, number>()
  private readonly reconnectTimers = new Map<number, NodeJS.Timeout>()
  private readonly statusTimers = new Map<number, NodeJS.Timeout>()
  private readonly transmissions = new TransmissionTracker()
  private expectedNodes: Set<string>
  private overrides: Record<string, string> = {}
  private refreshTimer?: NodeJS.Timeout
  private stopped = true
  private lastFingerprint?: string
  private snapshot?: StatusSnapshot

  constructor(options: Allmon3ServiceOptions) {
    this.definitions = options.nodes
    this.expectedNodes = new Set(Object.keys(options.nodes))
    this.refreshIntervalMs = options.refreshIntervalMs
    this.requestTimeoutMs = options.requestTimeoutMs
    this.notifier = new SnapshotNotifier(options.onChange)
    this.api = new Allmon3ApiClient(options.baseUrl, options.requestTimeoutMs)
  }

  get currentSnapshot(): StatusSnapshot | undefined {
    return this.snapshot
  }

  start(): void {
    if (!this.stopped)
      return
    this.stopped = false
    this.emitIfChanged()
    void this.refreshLoop()
  }

  stop(): void {
    this.stopped = true
    this.notifier.stop()
    if (this.refreshTimer)
      clearTimeout(this.refreshTimer)
    for (const timer of this.reconnectTimers.values())
      clearTimeout(timer)
    this.reconnectTimers.clear()
    for (const timer of this.statusTimers.values())
      clearTimeout(timer)
    this.statusTimers.clear()
    for (const socket of this.sockets.values())
      socket.close(1001, 'Gateway shutting down')
    this.sockets.clear()
  }

  private async refreshLoop(): Promise<void> {
    try {
      await this.refreshCatalog()
    }
    catch (error) {
      console.warn('Failed to refresh Allmon3 node catalog:', error)
    }
    finally {
      if (!this.stopped) {
        this.refreshTimer = setTimeout(() => {
          void this.refreshLoop()
        }, this.refreshIntervalMs)
      }
    }
  }

  private async refreshCatalog(): Promise<void> {
    const [nodeIdsResult, overridesResult] = await Promise.allSettled([
      this.api.nodeIds(),
      this.api.overrides(),
    ])

    if (overridesResult.status === 'fulfilled')
      this.overrides = overridesResult.value
    else
      console.warn('Failed to refresh Allmon3 node name overrides:', overridesResult.reason)

    if (nodeIdsResult.status === 'rejected')
      throw nodeIdsResult.reason

    const remoteNodes = [...new Set(nodeIdsResult.value.map(String))]
    const configResults = await Promise.allSettled(remoteNodes.map(node => this.api.nodeConfig(node)))
    const mergedConfigs = mergeNodeConfigs(remoteNodes, configResults, this.configs)

    for (const node of mergedConfigs.retained)
      console.warn(`Failed to refresh Allmon3 node ${node} config; keeping previous config`)
    for (const node of mergedConfigs.unavailable) {
      this.details.set(node, {
        ERROR: 'Allmon3 node config is unavailable',
        ME: Number(node),
        ONLINE: false,
      })
      console.warn(`Failed to load Allmon3 node ${node} config`)
    }

    const nextNodes = new Set([...Object.keys(this.definitions), ...remoteNodes])
    const remoteNodeSet = new Set(remoteNodes)
    const previousNodes = this.expectedNodes
    this.expectedNodes = nextNodes
    this.configs.clear()
    for (const [node, config] of mergedConfigs.configs)
      this.configs.set(node, config)

    for (const node of Object.keys(this.definitions)) {
      if (!remoteNodeSet.has(node)) {
        this.details.set(node, {
          ERROR: 'Allmon3 node is not listed',
          ME: Number(node),
          ONLINE: false,
        })
      }
    }

    for (const node of previousNodes) {
      if (!nextNodes.has(node)) {
        this.details.delete(node)
        this.transmissions.delete(node)
      }
    }

    this.reconcileSockets()
    this.emitIfChanged()
  }

  private reconcileSockets(): void {
    const desiredPorts = new Set([...this.configs.values()].map(config => config.statport))
    for (const [port, socket] of this.sockets) {
      if (!desiredPorts.has(port)) {
        this.sockets.delete(port)
        socket.close(1000, 'Port removed from Allmon3 catalog')
      }
    }
    for (const port of desiredPorts)
      this.connectPort(port)
  }

  private connectPort(port: number): void {
    if (this.stopped || this.sockets.has(port) || !this.isDesiredPort(port))
      return

    const socket = new WebSocket(this.api.statusWebSocketUrl(port), {
      handshakeTimeout: this.requestTimeoutMs,
    })
    this.sockets.set(port, socket)
    this.armStatusTimeout(port, socket)

    socket.on('message', (data) => {
      this.reconnectAttempts.set(port, 0)
      this.armStatusTimeout(port, socket)
      this.handleStatusMessage(port, data.toString())
    })
    socket.on('error', (error) => {
      console.warn(`Allmon3 status WebSocket ${port} error:`, error.message)
    })
    socket.on('close', () => {
      this.clearStatusTimeout(port)
      if (this.sockets.get(port) === socket)
        this.sockets.delete(port)
      if (this.stopped)
        return
      this.markPortUnavailable(port)
      this.scheduleReconnect(port)
    })
  }

  private handleStatusMessage(port: number, text: string): void {
    try {
      const message = JSON.parse(text) as unknown
      if (!isRecord(message))
        throw new Error('message is not a JSON object')

      for (const node of this.nodesForPort(port)) {
        const value = message[node]
        if (isRecord(value)) {
          this.details.set(node, {
            ...(value as NodeStatus),
            ERROR: null,
            ONLINE: true,
          })
        }
        else if (value === 'ERROR') {
          this.details.set(node, {
            ERROR: typeof message.ERROR === 'string' ? message.ERROR : 'Allmon3 node is unavailable',
            ME: Number(node),
            ONLINE: false,
          })
        }
      }
      this.emitIfChanged()
    }
    catch (error) {
      console.warn(`Ignoring invalid Allmon3 status message from port ${port}:`, error)
    }
  }

  private markPortUnavailable(port: number): void {
    let changed = false
    for (const node of this.nodesForPort(port)) {
      const current = this.details.get(node)
      if (current?.ERROR === 'Allmon3 status WebSocket disconnected')
        continue
      this.details.set(node, {
        ...(current ?? { ME: Number(node) }),
        ERROR: 'Allmon3 status WebSocket disconnected',
        ONLINE: false,
      })
      changed = true
    }
    if (changed)
      this.emitIfChanged()
  }

  private armStatusTimeout(port: number, socket: WebSocket): void {
    this.clearStatusTimeout(port)
    const timer = setTimeout(() => {
      if (this.sockets.get(port) !== socket)
        return
      this.markPortUnavailable(port)
      socket.terminate()
    }, this.requestTimeoutMs)
    this.statusTimers.set(port, timer)
  }

  private clearStatusTimeout(port: number): void {
    const timer = this.statusTimers.get(port)
    if (timer)
      clearTimeout(timer)
    this.statusTimers.delete(port)
  }

  private scheduleReconnect(port: number): void {
    if (this.stopped || !this.isDesiredPort(port) || this.reconnectTimers.has(port))
      return
    const attempt = (this.reconnectAttempts.get(port) ?? 0) + 1
    this.reconnectAttempts.set(port, attempt)
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt - 1, 5))
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(port)
      this.connectPort(port)
    }, delay)
    this.reconnectTimers.set(port, timer)
  }

  private emitIfChanged(): void {
    const snapshot = buildSnapshot(this.expectedNodes, this.details, this.overrides, this.definitions)
    this.transmissions.enrich(snapshot)
    this.snapshot = snapshot
    const fingerprint = statusFingerprint(snapshot)
    if (fingerprint === this.lastFingerprint)
      return

    this.lastFingerprint = fingerprint
    this.notifier.schedule(snapshot)
  }

  private nodesForPort(port: number): string[] {
    return [...this.configs]
      .filter(([, config]) => config.statport === port)
      .map(([node]) => node)
  }

  private isDesiredPort(port: number): boolean {
    return [...this.configs.values()].some(config => config.statport === port)
  }
}
