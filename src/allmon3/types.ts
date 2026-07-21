export type JsonValue = boolean | null | number | string | JsonValue[] | { [key: string]: JsonValue }
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

export interface NodeStatusFields {
  AUDIO: boolean
  CONNKEYED: boolean
  CONNKEYEDNODE: boolean | number | string
  CONNS: Record<string, Record<string, JsonValue>>
  DESC: string
  ERROR: string | null
  FREQ: string
  LAST_TX_AT: string | null
  LINK: string[]
  ME: number
  NAME: string
  ONLINE: boolean
  RXKEYED: boolean
  TXEKEYED: boolean
  TXKEYED: boolean
  TX_SOURCE: TransmitSource
  TYPE: NodeType
}

export type NodeStatus = Partial<NodeStatusFields> & Record<string, JsonValue | undefined>
export type StatusSnapshot = Record<string, NodeStatus>

export interface PublicConnectionStatus {
  CSTATE: 'ESTABLISHED'
}

export interface PublicNodeStatusFields {
  AUDIO: boolean
  CONNS: Record<string, PublicConnectionStatus>
  DESC: string
  FREQ: string
  LAST_TX_AT: string | null
  LINK: string[]
  LISTENERS: number
  NAME: string
  ONLINE: boolean
  TX_SOURCE: TransmitSource
  TYPE: NodeType
}

// Browser status payloads intentionally keep only the fields consumed by map.js.
// Public CONNS includes established links only; transient states such as
// CONNECTING stay in the full in-memory NodeStatus until the UI needs them.
// Full Allmon3 node details remain in NodeStatus/StatusSnapshot in memory; fields
// such as CONNKEYED, CTIME, ERROR, ME, RXKEYED, TXEKEYED, TXKEYED, UPTIME, and
// vendor/raw extension fields can be added back here when the UI needs them.
export type PublicNodeStatus = Partial<PublicNodeStatusFields>
export type PublicStatusSnapshot = Record<string, PublicNodeStatus>

export interface NodeConfig {
  cmdport?: number
  statport: number
}

export interface Allmon3ServiceOptions {
  baseUrl: string
  nodes: NodeDefinitions
  refreshIntervalMs: number
  requestTimeoutMs: number
  onChange: (snapshot: StatusSnapshot) => void
}
