import type { PublicStatusSnapshot } from '@iaxweb/contracts'
import type { CountyShape, Position } from './map-geometry'
import type { RepeaterState } from './status-presentation'
import { projectPoint } from './map-geometry'
import { repeaterState } from './status-presentation'

interface RepeaterMarker {
  center: Position
  key: string
  name: string
  state: RepeaterState
}

const statePriority: Record<RepeaterState, number> = {
  offline: 0,
  online: 1,
  system: 2,
  remote: 3,
  local: 4,
}

export function mapStates(snapshot: PublicStatusSnapshot): ReadonlyMap<string, RepeaterState> {
  const states = new Map<string, RepeaterState>()
  for (const node of Object.values(snapshot)) {
    if (node.TYPE !== 'REPEATER' || !node.GB || node.LOCATION)
      continue
    const state = repeaterState(node)
    const current = states.get(node.GB)
    if (!current || statePriority[state] > statePriority[current])
      states.set(node.GB, state)
  }
  return states
}

export function mapRepeaterMarkers(snapshot: PublicStatusSnapshot, counties: readonly CountyShape[]): RepeaterMarker[] {
  const countyStates = mapStates(snapshot)
  const markers: RepeaterMarker[] = []
  for (const { center, gb, name } of counties) {
    const state = countyStates.get(gb)
    if (center && state)
      markers.push({ center, key: `county-${gb}`, name, state })
  }
  for (const [id, node] of Object.entries(snapshot)) {
    if (node.TYPE !== 'REPEATER' || !node.LOCATION)
      continue
    markers.push({
      center: projectPoint([node.LOCATION.lon, node.LOCATION.lat]),
      key: `node-${id}`,
      name: node.NAME ?? `节点 ${id}`,
      state: repeaterState(node),
    })
  }
  return markers
}
