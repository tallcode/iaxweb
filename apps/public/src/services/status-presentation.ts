import type { PublicNodeStatus, PublicStatusSnapshot, TransmitSource } from '@iaxweb/contracts'

export type StatusConnectionState = 'connecting' | 'invalid-data' | 'ready' | 'reconnecting' | 'waiting-snapshot'
export type RepeaterState = 'online' | 'offline' | NonNullable<TransmitSource>

export const repeaterStateLabels: Record<RepeaterState, string> = {
  online: '在线',
  offline: '离线',
  local: '本地发射',
  remote: '远程发射',
  system: '系统发射',
}

const summaryCallsigns = ['BR5AI', 'BR5BB', 'BR5AF', 'BR5AO', 'BR5AR']

export function repeaterState(node: PublicNodeStatus | undefined): RepeaterState {
  return node?.ONLINE === true ? node.TX_SOURCE ?? 'online' : 'offline'
}

export function repeaterSummaryDots(snapshot: PublicStatusSnapshot) {
  const repeaters = Object.values(snapshot).filter(node => node.TYPE === 'REPEATER')
  return summaryCallsigns.map((callsign) => {
    const state = repeaterState(repeaters.find(node => node.NAME === callsign))
    return { callsign, state, label: `${callsign} · ${repeaterStateLabels[state]}` }
  })
}
