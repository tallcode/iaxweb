import type { AudioQuality, PersistedRecord, RadioSignal, RecordPage } from '@iaxweb/contracts'
import type { ManualReviewPatch, PendingReviewedVoiceprint, ReadyVoiceprint, RecognitionRecord, SpeakerReferenceGroup, SpeakerSearchResult, SpeechHour, StoredSpot, Voiceprint } from './types.js'

interface RecordLookup {
  find: (id: string) => PersistedRecord | undefined
}

export interface RecognitionRepository extends RecordLookup {
  insert: (nodeId: string, record: RecognitionRecord) => void
  updateAutomaticCallsign: (record: RecognitionRecord) => boolean
  updateSignaling?: (id: string, signals: readonly RadioSignal[]) => boolean
}

export interface SpeakerReferenceRepository extends RecordLookup {
  findReadyVoiceprint: (id: string) => ReadyVoiceprint | undefined
  saveQueryVoiceprint: (id: string, voiceprint: ReadyVoiceprint) => void
  updateAudioQuality: (id: string, quality: AudioQuality) => boolean
  pendingReviewedVoiceprints: (limit?: number) => PendingReviewedVoiceprint[]
  prepareReviewedVoiceprint: (id: string) => boolean
  updateVoiceprint: (id: string, voiceprint: Voiceprint) => boolean
  searchSpeakerMatches: (voiceprint: Voiceprint, excludeId: string) => SpeakerSearchResult
  recentSpeakerReferences: (callsigns: string[], excludeId: string) => SpeakerReferenceGroup[]
}

export interface ReviewRepository extends RecordLookup {
  updateManualReview: (id: string, patch: ManualReviewPatch, allowReviewed?: boolean) => boolean
  delete: (id: string, removeRecording: () => void) => boolean
}

export interface RecordListRepository extends ReviewRepository {
  list: (page: number, pageSize: number, callsign?: string, editedOnly?: boolean, reviewedOnly?: boolean) => RecordPage
}

export interface PublicRecordQueries {
  speechHours: (startAt: string, endAt: string) => SpeechHour[]
  recentSpots: (limit?: number) => StoredSpot[]
}
