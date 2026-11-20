import type { PublicStatusSnapshot } from '@iaxweb/contracts'

export type CountyState = 'offline' | 'online' | 'local' | 'remote' | 'system'

const statePriority: Record<CountyState, number> = {
  offline: 0,
  online: 1,
  system: 2,
  remote: 3,
  local: 4,
}

export function mapStates(snapshot: PublicStatusSnapshot): ReadonlyMap<string, CountyState> {
  const states = new Map<string, CountyState>()
  for (const node of Object.values(snapshot)) {
    if (node.TYPE !== 'REPEATER' || !node.GB)
      continue
    const state = node.ONLINE === true ? node.TX_SOURCE ?? 'online' : 'offline'
    const current = states.get(node.GB)
    if (!current || statePriority[state] > statePriority[current])
      states.set(node.GB, state)
  }
  return states
}
