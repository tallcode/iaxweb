export type StatusConnectionState = 'connecting' | 'invalid-data' | 'ready' | 'reconnecting' | 'waiting-snapshot'

export interface RepeaterSummary {
  online: number
  total: number
  transmitting: number
}

export function formatRepeaterSummary(summary: RepeaterSummary, isMobile: boolean): string {
  if (isMobile)
    return `${summary.total}/${summary.online}/${summary.transmitting}`
  return `${summary.total} 个节点 · ${summary.online} 个在线 · ${summary.transmitting} 个正在发射`
}
