import type { PublicConnectionStatus, PublicStatusSnapshot } from '@iaxweb/contracts'

export interface TopologyEdge {
  connected: boolean
  source: string
  target: string
}

export function buildTopologyEdges(snapshot: PublicStatusSnapshot): TopologyEdge[] {
  const knownNodes = new Set(Object.keys(snapshot))
  const edgesByPair = new Map<string, TopologyEdge>()

  for (const [nodeId, node] of Object.entries(snapshot)) {
    for (const linkedId of node.LINK ?? []) {
      if (!knownNodes.has(linkedId))
        continue
      const pair = [nodeId, linkedId].sort((left, right) => Number(left) - Number(right))
      const source = pair[0]
      const target = pair[1]
      if (!source || !target)
        continue
      edgesByPair.set(pair.join(':'), { connected: isConnected(snapshot, source, target), source, target })
    }

    for (const [connectedId, connection] of Object.entries(node.CONNS ?? {})) {
      if (!knownNodes.has(connectedId) || !connectionIsEstablished(connection))
        continue
      const pair = [nodeId, connectedId].sort((left, right) => Number(left) - Number(right))
      const source = pair[0]
      const target = pair[1]
      if (!source || !target)
        continue
      const key = pair.join(':')
      if (!edgesByPair.has(key))
        edgesByPair.set(key, { connected: true, source, target })
    }
  }
  return [...edgesByPair.values()]
}

export function createTopologySignature(
  nodeIds: string[],
  edges: TopologyEdge[],
  isMobile: boolean,
): string {
  const edgePairs = edges.map(edge => `${edge.source}:${edge.target}`).sort()
  return JSON.stringify([isMobile, [...nodeIds].sort(), edgePairs])
}

function isConnected(snapshot: PublicStatusSnapshot, source: string, target: string): boolean {
  return Boolean(connectionIsEstablished(snapshot[source]?.CONNS?.[target])
    || connectionIsEstablished(snapshot[target]?.CONNS?.[source]))
}

function connectionIsEstablished(connection: PublicConnectionStatus | undefined): boolean {
  return connection?.CSTATE === 'ESTABLISHED'
}
