import type { SpeakerMatch } from '@iaxweb/contracts'

export interface SpeakerReferenceGroup {
  callsign: string
  embeddings: Float32Array[]
}

export type SpeakerReferenceScore = Pick<SpeakerMatch, 'callsign' | 'referenceSimilarity' | 'referenceRecordCount' | 'trimmedReferenceSimilarity' | 'trimmedReferenceRecordCount'>

export type Voiceprint = { version: string, reason?: string | undefined } & (
  | { status: 'ready', embedding: Float32Array }
  | { status: 'pending' | 'unavailable' | 'failed' }
)

// Persistence accepts recognition data without depending on audio buffers or AI runtime state.
export interface RecognitionRecord {
  id: string
  timestamp: string
  durationMs: number
  voicedMs: number
  recognition?: string | undefined
  corrected?: string | undefined
  revise?: string | undefined
  callsign?: string | undefined
  risk?: { level: number, reason: string } | undefined
}
