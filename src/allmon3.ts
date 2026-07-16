import { WebSocket } from 'ws'

export type JsonValue = boolean | null | number | string | JsonValue[] | { [key: string]: JsonValue }
export type NodeStatus = Record<string, JsonValue>
export type StatusSnapshot = Record<string, NodeStatus>
export type TransmitSource = 'local' | 'remote' | 'system' | null
export type NodeType = 'HUB' | 'REPEATER'

export interface NodeDefinition {
  AUDIO?: boolean
  FREQ?: string
  LINK?: string[]
  NAME?: string
  TYPE: NodeType
}

export type NodeDefinitions = Record<string, NodeDefinition>

interface Allmon3Options {
  baseUrl: string
  nodes: NodeDefinitions
  refreshIntervalMs: number
  requestTimeoutMs: number
  onChange: (snapshot: StatusSnapshot) => void
}

interface NodeConfig {
  cmdport?: number
  statport: number
}

interface SuccessResponse<T> {
  SUCCESS: T
}

interface TransmissionState {
  activeSource: TransmitSource
  lastTransmitAt: string | null
}

const volatileFields = new Set(['CTIME', 'RELOADTIME', 'SSK', 'SSU', 'UPTIME'])

export class Allmon3StatusService {
  private readonly baseUrl: URL
  private readonly refreshIntervalMs: number
  private readonly requestTimeoutMs: number
  private readonly onChange: (snapshot: StatusSnapshot) => void
  private readonly definitions: NodeDefinitions
  private readonly configs = new Map<string, NodeConfig>()
  private readonly details = new Map<string, NodeStatus>()
  private readonly sockets = new Map<number, WebSocket>()
  private readonly reconnectAttempts = new Map<number, number>()
  private readonly reconnectTimers = new Map<number, NodeJS.Timeout>()
  private readonly statusTimers = new Map<number, NodeJS.Timeout>()
  private readonly transmissions = new Map<string, TransmissionState>()
  private expectedNodes = new Set<string>()
  private overrides: Record<string, string> = {}
  private refreshTimer?: NodeJS.Timeout
  private stopped = true
  private lastFingerprint?: string
  private snapshot?: StatusSnapshot

  constructor(options: Allmon3Options) {
    this.baseUrl = new URL(options.baseUrl)
    this.definitions = options.nodes
    this.expectedNodes = new Set(Object.keys(options.nodes))
    this.refreshIntervalMs = options.refreshIntervalMs
    this.requestTimeoutMs = options.requestTimeoutMs
    this.onChange = options.onChange
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
    const [nodeIds, overrides] = await Promise.all([
      this.fetchSuccess<number[]>('master/node/listall'),
      this.fetchSuccess<Record<string, string>>('master/ui/custom/overrides'),
    ])
    const remoteNodes = [...new Set(nodeIds.map(String))]
    const configs = await Promise.all(remoteNodes.map(async node => [
      node,
      await this.fetchSuccess<NodeConfig>(`master/node/${node}/config`),
    ] as const))

    const nextNodes = new Set([...Object.keys(this.definitions), ...remoteNodes])
    const remoteNodeSet = new Set(remoteNodes)
    const previousNodes = this.expectedNodes
    this.expectedNodes = nextNodes
    this.overrides = overrides
    this.configs.clear()

    for (const [node, nodeConfig] of configs) {
      if (!Number.isInteger(nodeConfig.statport))
        throw new Error(`Allmon3 node ${node} returned an invalid statport`)
      this.configs.set(node, nodeConfig)
    }

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

    const socket = new WebSocket(this.statusWebSocketUrl(port), {
      handshakeTimeout: this.requestTimeoutMs,
    })
    this.sockets.set(port, socket)
    this.armStatusTimeout(port, socket)

    socket.on('open', () => {
      this.reconnectAttempts.set(port, 0)
    })
    socket.on('message', (data) => {
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

    this.enrichTransmissionState(snapshot)
    this.snapshot = snapshot
    const fingerprint = statusFingerprint(snapshot)
    if (fingerprint === this.lastFingerprint)
      return

    this.lastFingerprint = fingerprint
    this.onChange(snapshot)
  }

  private enrichTransmissionState(snapshot: StatusSnapshot): void {
    const now = new Date().toISOString()
    for (const [node, status] of Object.entries(snapshot)) {
      if (status.TYPE === 'HUB') {
        this.transmissions.delete(node)
        status.TX_SOURCE = null
        status.LAST_TX_AT = null
        continue
      }
      const source = transmitSource(status)
      const previous = this.transmissions.get(node)
      const lastTransmitAt = source && source !== previous?.activeSource
        ? now
        : previous?.lastTransmitAt ?? null

      this.transmissions.set(node, { activeSource: source, lastTransmitAt })
      status.TX_SOURCE = source
      status.LAST_TX_AT = lastTransmitAt
    }
  }

  private nodesForPort(port: number): string[] {
    return [...this.configs]
      .filter(([, config]) => config.statport === port)
      .map(([node]) => node)
  }

  private isDesiredPort(port: number): boolean {
    return [...this.configs.values()].some(config => config.statport === port)
  }

  private statusWebSocketUrl(port: number): string {
    const url = new URL(`ws/${port}`, this.baseUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return url.toString()
  }

  private async fetchSuccess<T>(path: string): Promise<T> {
    const response = await fetch(new URL(path, this.baseUrl), {
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    })
    if (!response.ok)
      throw new Error(`Allmon3 ${path} returned HTTP ${response.status}`)
    const body = await response.json() as unknown
    if (!isRecord(body) || !('SUCCESS' in body))
      throw new Error(`Allmon3 ${path} returned an invalid response`)
    return (body as unknown as SuccessResponse<T>).SUCCESS
  }
}

export function buildSnapshot(
  expectedNodes: Set<string>,
  details: Map<string, NodeStatus>,
  overrides: Record<string, string>,
  definitions: NodeDefinitions = {},
): StatusSnapshot {
  const snapshot: StatusSnapshot = {}
  const nodes = [...expectedNodes].sort((left, right) => Number(left) - Number(right))
  for (const node of nodes) {
    const detail = details.get(node)
    snapshot[node] = {
      ...defaultNodeStatus(node, definitions[node]),
      ...(detail ?? {}),
      ...definitionFields(definitions[node]),
      ...(overrides[node] ? { DESC: overrides[node] } : {}),
    }
  }
  return snapshot
}

export function parseNodeDefinitions(value: unknown): NodeDefinitions {
  if (!isRecord(value))
    throw new Error('nodes.json must contain a JSON object')

  const definitions: NodeDefinitions = {}
  for (const [node, rawDefinition] of Object.entries(value)) {
    if (!/^\d+$/.test(node) || !isRecord(rawDefinition))
      throw new Error(`nodes.json contains an invalid node: ${node}`)
    const type = rawDefinition.TYPE
    if (type !== 'HUB' && type !== 'REPEATER')
      throw new Error(`nodes.json node ${node} must use TYPE HUB or REPEATER`)
    const link = rawDefinition.LINK
    if (link !== undefined && (!Array.isArray(link) || !link.every(target => typeof target === 'string' && /^\d+$/.test(target))))
      throw new Error(`nodes.json node ${node} has an invalid LINK list`)
    const freq = rawDefinition.FREQ
    if (freq !== undefined && typeof freq !== 'string')
      throw new Error(`nodes.json node ${node} has an invalid FREQ`)
    const name = rawDefinition.NAME
    if (name !== undefined && typeof name !== 'string')
      throw new Error(`nodes.json node ${node} has an invalid NAME`)

    const audio = rawDefinition.AUDIO
    if (audio !== undefined && typeof audio !== 'boolean')
      throw new Error(`nodes.json node ${node} has an invalid AUDIO`)

    definitions[node] = {
      TYPE: type,
      ...(audio !== undefined ? { AUDIO: audio } : {}),
      ...(link ? { LINK: [...link] } : {}),
      ...(freq ? { FREQ: freq } : {}),
      ...(name ? { NAME: name } : {}),
    }
  }
  return definitions
}

export function statusFingerprint(snapshot: StatusSnapshot): string {
  return JSON.stringify(normalizeForComparison(snapshot))
}

export function transmitSource(status: NodeStatus): TransmitSource {
  if (status.ERROR || status.TXKEYED !== true)
    return null
  if (status.RXKEYED === true)
    return 'local'
  if (status.CONNKEYED === true)
    return 'remote'
  return 'system'
}

function normalizeForComparison(value: JsonValue): JsonValue {
  if (Array.isArray(value))
    return value.map(normalizeForComparison)
  if (!isRecord(value))
    return value

  const normalized: Record<string, JsonValue> = {}
  for (const key of Object.keys(value).sort()) {
    if (!volatileFields.has(key))
      normalized[key] = normalizeForComparison(value[key] as JsonValue)
  }
  return normalized
}

function defaultNodeStatus(node: string, definition?: NodeDefinition): NodeStatus {
  return {
    CONNKEYED: false,
    CONNKEYEDNODE: false,
    CONNS: {},
    DESC: '',
    ERROR: 'Waiting for Allmon3 status',
    LAST_TX_AT: null,
    ME: Number(node),
    ONLINE: false,
    RXKEYED: false,
    TXEKEYED: false,
    TXKEYED: false,
    TX_SOURCE: null,
    TYPE: definition?.TYPE ?? 'REPEATER',
    ...definitionFields(definition),
  }
}

function definitionFields(definition?: NodeDefinition): NodeStatus {
  return {
    ...(definition?.AUDIO !== undefined ? { AUDIO: definition.AUDIO } : {}),
    LINK: definition?.LINK ?? [],
    TYPE: definition?.TYPE ?? 'REPEATER',
    ...(definition?.FREQ ? { FREQ: definition.FREQ } : {}),
    ...(definition?.NAME ? { NAME: definition.NAME } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
