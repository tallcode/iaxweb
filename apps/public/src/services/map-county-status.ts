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

interface CountyRepeaterStatus {
  name: string | undefined
  state: RepeaterState
}

const statePriority: Record<RepeaterState, number> = {
  offline: 0,
  online: 1,
  system: 2,
  remote: 3,
  local: 4,
}

function mapCountyStatuses(snapshot: PublicStatusSnapshot): ReadonlyMap<string, CountyRepeaterStatus> {
  const statuses = new Map<string, CountyRepeaterStatus>()
  for (const node of Object.values(snapshot)) {
    if (node.TYPE !== 'REPEATER' || !node.GB || node.LOCATION)
      continue
    const state = repeaterState(node)
    const current = statuses.get(node.GB)
    if (!current || statePriority[state] > statePriority[current.state])
      statuses.set(node.GB, { name: node.NAME, state })
  }
  return statuses
}

export function mapRepeaterMarkers(snapshot: PublicStatusSnapshot, counties: readonly CountyShape[]): RepeaterMarker[] {
  const countyStatuses = mapCountyStatuses(snapshot)
  const markers: RepeaterMarker[] = []
  for (const { center, gb, name } of counties) {
    const status = countyStatuses.get(gb)
    if (center && status)
      markers.push({ center, key: `county-${gb}`, name: status.name ?? name, state: status.state })
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
