export type StatusConnectionState = 'connecting' | 'invalid-data' | 'ready' | 'reconnecting' | 'waiting-snapshot'

export interface RepeaterSummary {
  online: number
  total: number
  transmitting: number
}

export function connectionStatusMessage(state: StatusConnectionState): string {
  switch (state) {
    case 'connecting':
      return '正在连接状态服务…'
    case 'invalid-data':
      return '收到无法解析的状态数据'
    case 'reconnecting':
      return '状态服务已断开，正在重连…'
    case 'waiting-snapshot':
      return '已连接，等待完整节点状态…'
    case 'ready':
      return ''
  }
}

export function formatRepeaterSummary(summary: RepeaterSummary, isMobile: boolean): string {
  if (isMobile)
    return `${summary.total}/${summary.online}/${summary.transmitting}`
  return `${summary.total} 个节点 · ${summary.online} 个在线 · ${summary.transmitting} 个正在发射`
}

export function headerStatusMessage(
  state: StatusConnectionState,
  summary: RepeaterSummary,
  isMobile: boolean,
): string {
  return state === 'ready' ? formatRepeaterSummary(summary, isMobile) : connectionStatusMessage(state)
}

export function loadingStatusMessage(
  state: StatusConnectionState,
  hasInitialSnapshot: boolean,
  isPageReady: boolean,
): string {
  if (hasInitialSnapshot && !isPageReady)
    return '正在准备页面…'
  return connectionStatusMessage(state)
}
