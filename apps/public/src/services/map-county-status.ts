import type { PublicStatusSnapshot, TransmitSource } from '@iaxweb/contracts'

export type CountyState = 'offline' | 'online' | 'tx-local' | 'tx-remote' | 'tx-system'

interface MapStates {
  onlineCities: Set<string>
  transmittingCounties: Map<string, CountyState>
}

const transmissionPriority: Record<Extract<CountyState, `tx-${string}`>, number> = {
  'tx-system': 2,
  'tx-remote': 3,
  'tx-local': 4,
}

export function mapStates(snapshot: PublicStatusSnapshot): MapStates {
  const onlineCities = new Set<string>()
  const transmittingCounties = new Map<string, CountyState>()
  for (const node of Object.values(snapshot)) {
    if (node.TYPE !== 'REPEATER' || !node.GB)
      continue
    if (node.ONLINE !== true)
      continue
    onlineCities.add(node.GB.slice(0, 7))
    const state = transmissionState(node.TX_SOURCE)
    const current = transmittingCounties.get(node.GB)
    if (state && (!current || transmissionPriority[state] > transmissionPriority[current as Extract<CountyState, `tx-${string}`>]))
      transmittingCounties.set(node.GB, state)
  }
  return { onlineCities, transmittingCounties }
}

export function countyState(gb: string, states: MapStates): CountyState {
  return states.transmittingCounties.get(gb)
    ?? (states.onlineCities.has(gb.slice(0, 7)) ? 'online' : 'offline')
}

function transmissionState(source: TransmitSource | undefined): Extract<CountyState, `tx-${string}`> | undefined {
  if (source === 'local')
    return 'tx-local'
  if (source === 'remote')
    return 'tx-remote'
  if (source === 'system')
    return 'tx-system'
  return undefined
}
