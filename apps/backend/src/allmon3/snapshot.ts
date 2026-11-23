import type { JsonValue, NodeDefinition, NodeDefinitions, NodeStatus, NodeStatusFields, PublicConnectionStatus, PublicNodeStatus, PublicStatusSnapshot, StatusSnapshot } from './types.js'
import { isRecord } from './definitions.js'

const volatileFields = new Set(['CTIME', 'RELOADTIME', 'SSK', 'SSU', 'UPTIME'])

export function buildSnapshot(
  expectedNodes: Set<string>,
  details: Map<string, NodeStatus>,
  overrides: Record<string, string>,
  definitions: NodeDefinitions = {},
): StatusSnapshot {
  const snapshot: StatusSnapshot = {}
  const nodes = [...expectedNodes].sort((left, right) => Number(left) - Number(right))
  for (const node of nodes) {
    const definition = definitions[node]
    const detail = details.get(node)
    snapshot[node] = {
      ...defaultNodeStatus(node, definition),
      ...(detail ?? {}),
      ...definitionFields(definition),
      // Node coordinates come from the local configuration.
      LOCATION: definition?.LOCATION,
      ...(overrides[node] ? { DESC: overrides[node] } : {}),
    }
  }
  return snapshot
}

export function statusFingerprint(snapshot: StatusSnapshot): string {
  return JSON.stringify(normalizeForComparison(snapshot))
}

export function publicStatusSnapshot(
  snapshot: StatusSnapshot,
  listeners: ReadonlyMap<string, number> = new Map(),
  spotPublishingEnabled?: boolean,
): PublicStatusSnapshot {
  return Object.fromEntries(Object.entries(snapshot).map(([node, status]) => [
    node,
    publicNodeStatus(status, listeners.get(node), spotPublishingEnabled),
  ]))
}

function normalizeForComparison(value: unknown): JsonValue {
  if (Array.isArray(value))
    return value.map(normalizeForComparison)
  if (!isRecord(value))
    return value as JsonValue

  const normalized: Record<string, JsonValue> = {}
  for (const key of Object.keys(value).sort()) {
    const field = value[key]
    if (!volatileFields.has(key) && field !== undefined)
      normalized[key] = normalizeForComparison(field)
  }
  return normalized
}

function publicNodeStatus(status: NodeStatus, listeners?: number, spotPublishingEnabled?: boolean): PublicNodeStatus {
  const publicStatus: PublicNodeStatus = {}
  if (typeof status.AI === 'boolean')
    publicStatus.AI = status.AI
  if (status.AI === true && spotPublishingEnabled !== undefined)
    publicStatus.AI_SPOT = spotPublishingEnabled
  if (status.AUDIO !== undefined)
    publicStatus.AUDIO = status.AUDIO
  if (status.CONNS !== undefined)
    publicStatus.CONNS = publicConnections(status.CONNS)
  if (status.DESC !== undefined)
    publicStatus.DESC = status.DESC
  if (status.FREQ !== undefined)
    publicStatus.FREQ = status.FREQ
  if (status.GB !== undefined)
    publicStatus.GB = status.GB
  if (status.LAST_TX_AT !== undefined)
    publicStatus.LAST_TX_AT = status.LAST_TX_AT
  if (status.LINK !== undefined)
    publicStatus.LINK = status.LINK
  if (status.AUDIO === true)
    publicStatus.LISTENERS = listeners ?? 0
  if (status.LOCATION !== undefined)
    publicStatus.LOCATION = status.LOCATION
  if (status.NAME !== undefined)
    publicStatus.NAME = status.NAME
  if (status.ONLINE !== undefined)
    publicStatus.ONLINE = status.ONLINE
  if (status.TX_SOURCE !== undefined)
    publicStatus.TX_SOURCE = status.TX_SOURCE
  if (status.TYPE !== undefined)
    publicStatus.TYPE = status.TYPE
  return publicStatus
}

function publicConnections(connections: NodeStatusFields['CONNS']): Record<string, PublicConnectionStatus> {
  return Object.fromEntries(Object.entries(isRecord(connections) ? connections : {})
    .filter(([, connection]) => isRecord(connection) && connection.CSTATE === 'ESTABLISHED')
    .map(([node]) => [node, { CSTATE: 'ESTABLISHED' }]))
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
    ...(definition?.AI !== undefined ? { AI: definition.AI } : {}),
    ...(definition?.AUDIO !== undefined ? { AUDIO: definition.AUDIO } : {}),
    LINK: definition?.LINK ?? [],
    TYPE: definition?.TYPE ?? 'REPEATER',
    ...(definition?.FREQ ? { FREQ: definition.FREQ } : {}),
    ...(definition?.GB ? { GB: definition.GB } : {}),
    ...(definition?.NAME ? { NAME: definition.NAME } : {}),
  }
}
