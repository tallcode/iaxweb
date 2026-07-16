import type { JsonValue, NodeDefinition, NodeDefinitions, NodeStatus, StatusSnapshot } from './types.js'
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

export function statusFingerprint(snapshot: StatusSnapshot): string {
  return JSON.stringify(normalizeForComparison(snapshot))
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
