import type { RecordRepository } from './record-repository.js'

// Consumers depend only on the operations they need. Resource lifetime belongs
// to the server that creates the concrete SQLite repository.
export type RecognitionRepository = Pick<RecordRepository, 'insert' | 'updateAnalysis' | 'find'>
export type SpeakerReferenceRepository = Pick<RecordRepository, 'find' | 'findReadyVoiceprint' | 'saveQueryVoiceprint' | 'pendingReviewedVoiceprints' | 'prepareReviewedVoiceprint' | 'updateVoiceprint' | 'searchSpeakerMatches' | 'recentSpeakerReferences'>
export type ReviewRepository = Pick<RecordRepository, 'find' | 'updateManualReview' | 'delete'>
