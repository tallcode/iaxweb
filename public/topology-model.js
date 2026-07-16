export function collectEdges(snapshot) {
  const knownNodes = new Set(Object.keys(snapshot))
  const found = new Map()
  for (const [nodeId, node] of Object.entries(snapshot)) {
    for (const linkedId of node.LINK || []) {
      if (!knownNodes.has(linkedId))
        continue
      const pair = [nodeId, linkedId].sort((left, right) => Number(left) - Number(right))
      found.set(pair.join(':'), {
        connected: isConnected(snapshot, pair[0], pair[1]),
        source: pair[0],
        target: pair[1],
      })
    }
  }
  return [...found.values()]
}

export function graphSignature(nodeIds, edges, elements, mobile) {
  const sizes = nodeIds.map((nodeId) => {
    const element = elements.get(nodeId)
    return `${nodeId}:${element?.offsetWidth ?? 0}x${element?.offsetHeight ?? 0}`
  })
  const links = edges.map(edge => `${edge.source}:${edge.target}`).sort()
  return JSON.stringify([mobile, sizes, links])
}

function isConnected(snapshot, source, target) {
  return connectionIsEstablished(snapshot[source]?.CONNS?.[target])
    || connectionIsEstablished(snapshot[target]?.CONNS?.[source])
}

function connectionIsEstablished(connection) {
  return connection && (!connection.CSTATE || connection.CSTATE === 'ESTABLISHED')
}
