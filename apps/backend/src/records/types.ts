import type { AudioQuality, PersistedRecord, SpeakerMatch } from '@iaxweb/contracts'

export interface RecordPage {
  items: PersistedRecord[]
  page: number
  pageSize: number
  total: number
}

export interface SpeakerReferenceGroup {
  callsign: string
  embeddings: Float32Array[]
}

export type SpeakerReferenceScore = Pick<SpeakerMatch, 'callsign' | 'referenceSimilarity' | 'referenceRecordCount' | 'trimmedReferenceSimilarity' | 'trimmedReferenceRecordCount' | 'referenceGroups'>
type SpeakerSearchMatch = Omit<SpeakerMatch, 'confidence' | Exclude<keyof SpeakerReferenceScore, 'callsign'>>

export interface SpeakerSearchResult {
  referenceCount: number
  matches: SpeakerSearchMatch[]
}

export interface PendingReviewedVoiceprint {
  id: string
  timestamp: string
  voicedMs: number
}

export interface StoredSpot {
  at: string
  callsign: string
  id: string
  node: string
}

export interface SpeechHour {
  date: string
  hour: number
  count: number
  voicedMs: number
}

export interface ManualReviewPatch {
  callsign?: string | null
  calleeCallsign?: string | null
  recognition?: string | null
  reviewed?: boolean
  note?: string | null
}

export type Voiceprint = { version: string, reason?: string | undefined } & (
  | { status: 'ready', embedding: Float32Array }
  | { status: 'pending' | 'unavailable' | 'failed' }
)
export type ReadyVoiceprint = Extract<Voiceprint, { status: 'ready' }>

// Persistence accepts recognition data without depending on audio buffers or AI runtime state.
export interface RecognitionRecord {
  id: string
  timestamp: string
  sourceRepeaterId?: string | null | undefined
  durationMs: number
  voicedMs: number
  recognition?: string | undefined
  corrected?: string | undefined
  audioQuality?: AudioQuality | undefined
  callsign?: string | undefined
  callsignAlgorithm?: string | undefined
}
