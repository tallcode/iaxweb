import type { NodeStatus, NodeStatusFields, StatusSnapshot } from './types.js'

type ConnectionStatus = NodeStatusFields['CONNS'][string]

export function findSourceRepeaterId(snapshot: StatusSnapshot, hubId: string): string | null {
  const hub = snapshot[hubId]
  if (!isOnline(hub) || hub.TYPE !== 'HUB')
    return null

  const receptionLinks = buildReceptionLinks(snapshot)
  const visited = new Set([hubId])
  const reachable = [hubId]
  let sourceId: string | null = null

  while (reachable.length > 0) {
    const nodeId = reachable.pop()!
    const node = snapshot[nodeId]
    // A known node can still send audio over its link while its status feed is down.
    if (!isOnline(node))
      return null
    if (node.TYPE === 'REPEATER' && node.TX_SOURCE === 'local') {
      if (sourceId !== null)
        return null
      sourceId = nodeId
    }

    for (const peerId of receptionLinks.get(nodeId) ?? []) {
      if (!visited.has(peerId)) {
        visited.add(peerId)
        reachable.push(peerId)
      }
    }
  }

  return sourceId
}

function buildReceptionLinks(snapshot: StatusSnapshot): Map<string, Set<string>> {
  const links = new Map<string, Set<string>>()
  for (const [nodeId, node] of Object.entries(snapshot)) {
    if (!isOnline(node))
      continue

    for (const [peerId, connection] of Object.entries(node.CONNS ?? {})) {
      if (connection.CSTATE !== 'ESTABLISHED' || !Object.hasOwn(snapshot, peerId))
        continue

      const peer = snapshot[peerId]
      const peerOnline = isOnline(peer)
      const reverse = peerOnline ? peer.CONNS?.[nodeId] : undefined
      if (reverse?.CSTATE !== undefined && reverse.CSTATE !== 'ESTABLISHED')
        continue
      if (canReceive(connection, reverse))
        addReceptionLink(links, nodeId, peerId)
      if (peerOnline && canReceive(reverse, connection))
        addReceptionLink(links, peerId, nodeId)
    }
  }
  return links
}

function isOnline(node: NodeStatus | undefined): node is NodeStatus {
  return node?.ONLINE === true && !node.ERROR
}

function canReceive(receiver: ConnectionStatus | undefined, sender: ConnectionStatus | undefined): boolean {
  // Allmon3's Monitor mode is receive-only from the reporting node's perspective.
  // Local Monitor can be reported as UNSET or Unknown.
  const receiverMode = receiver?.MODE
  const senderMode = sender?.MODE
  return (receiverMode === undefined || receiverMode === 'Monitor' || receiverMode === 'Transceive')
    && (senderMode === undefined || senderMode === 'Transceive')
}

function addReceptionLink(links: Map<string, Set<string>>, receiverId: string, senderId: string): void {
  let senders = links.get(receiverId)
  if (!senders) {
    senders = new Set()
    links.set(receiverId, senders)
  }
  senders.add(senderId)
}
