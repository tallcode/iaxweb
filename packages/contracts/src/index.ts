export type TransmitSource = 'local' | 'remote' | 'system' | null
export type NodeType = 'HUB' | 'REPEATER'

export type AdminRole = 'admin' | 'editor' | 'viewer'

export interface AdminSession {
  role: AdminRole
  username: string
  system?: boolean
}

export interface AdminUsersPage {
  items: AdminSession[]
  user: AdminSession
}

export interface PublicConnectionStatus {
  CSTATE: 'ESTABLISHED'
}

export interface PublicNodeStatus {
  AI?: boolean
  AUDIO?: boolean
  CONNS?: Record<string, PublicConnectionStatus>
  DESC?: string
  FREQ?: string
  GB?: string
  LAST_TX_AT?: string | null
  LINK?: string[]
  LISTENERS?: number
  NAME?: string
  ONLINE?: boolean
  TX_SOURCE?: TransmitSource
  TYPE?: NodeType
}

export type PublicStatusSnapshot = Record<string, PublicNodeStatus>

export interface SpotEvent {
  at: string
  callsign: string
  id: string
  node: string
  type?: 'spot'
}

export interface PersistedSegment {
  calleeCallsign: string | null
  callsign: string | null
  capturedAt: string
  corrected: string | null
  createdAt: string
  durationMs: number
  effectiveCallsign: string | null
  effectiveRiskLevel: number | null
  id: string
  manualCallsign: string | null
  manualRecognition: string | null
  manualNote: string | null
  manualRiskLevel: number | null
  nodeId: string
  recognition: string
  reviewed: boolean
  revise: string | null
  riskLevel: number | null
  riskReason: string | null
  voicedMs: number
}

export interface SegmentPage {
  items: PersistedSegment[]
  page: number
  pageSize: number
  total: number
}

export interface AdminSegmentPage extends SegmentPage {
  recordingDates: string[]
  user: AdminSession
}
