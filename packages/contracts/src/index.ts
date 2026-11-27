import type { z } from 'zod'
import type {
  adminRecordPageSchema,
  adminSessionSchema,
  adminUsersPageSchema,
  AUDIO_INTERFERENCE_REASONS,
  audioQualitySchema,
  audioStateSchema,
  createUserSchema,
  loginSchema,
  persistedRecordSchema,
  publicStatsSchema,
  publicStatusRuntimeSnapshotSchema,
  publicStatusSnapshotSchema,
  radioSignalsSchema,
  speakerRecognitionSchema,
  spotEventSchema,
  statusStreamMessageSchema,
  updateUserSchema,
} from './schemas.js'

export type TransmitSource = Exclude<PublicNodeStatus['TX_SOURCE'], undefined>
export type NodeType = NonNullable<PublicNodeStatus['TYPE']>
export type AdminRole = AdminSession['role']
export type AdminSession = z.output<typeof adminSessionSchema>
export type AdminUsersPage = z.output<typeof adminUsersPageSchema>
export type PublicConnectionStatus = NonNullable<PublicNodeStatus['CONNS']>[string]
export type PublicNodeStatus = PublicStatusSnapshot[string]
export type PublicStatusSnapshot = z.output<typeof publicStatusSnapshotSchema>
export type PublicNodeRuntimeStatus = PublicStatusRuntimeSnapshot[string]
export type PublicStatusRuntimeSnapshot = z.output<typeof publicStatusRuntimeSnapshotSchema>
export type StatusStreamMessage = z.output<typeof statusStreamMessageSchema>
export type SpotEvent = z.output<typeof spotEventSchema>
export type PublicStats = z.output<typeof publicStatsSchema>
export type StatsDay = PublicStats['today']['day']
export type AudioState = z.output<typeof audioStateSchema>
export type AudioQuality = z.output<typeof audioQualitySchema>
export type AudioInterferenceReason = typeof AUDIO_INTERFERENCE_REASONS[number]
export type RadioSignal = z.output<typeof radioSignalsSchema>[number]
export type PersistedRecord = z.output<typeof persistedRecordSchema>
export type AdminRecord = AdminRecordPage['items'][number]
export type AdminRecordPage = z.output<typeof adminRecordPageSchema>
export type SpeakerMatch = SpeakerRecognition['matches'][number]
export type SpeakerRecognition = z.output<typeof speakerRecognitionSchema>
export type SpeakerRecognitionMeasurements = SpeakerRecognition['measurements']
export type LoginInput = z.input<typeof loginSchema>
export type CreateUserInput = z.input<typeof createUserSchema>
export type UpdateUserInput = z.input<typeof updateUserSchema>

export {
  CALLSIGN_PATTERN,
  CALLSIGN_PREFIX_SOURCE,
  CALLSIGN_SECOND_LETTERS,
  CALLSIGN_SOURCE,
  hasCallerCallsign,
  isDisplayableCallsign,
  isValidCallsign,
  MANUAL_CALLSIGN_PATTERN,
  MAX_RECOGNITION_LENGTH,
  NO_CALLSIGN,
  RECORD_CALLSIGN_FILTER_PATTERN,
  REVIEW_CALLSIGN_CLEAR_MESSAGE,
  REVIEW_CALLSIGN_REQUIRED_MESSAGE,
} from './callsign.js'
export {
  adminRecordPageSchema,
  adminSessionSchema,
  adminUsersPageSchema,
  AUDIO_INTERFERENCE_REASONS,
  AUDIO_QUALITY_GATE_VERSION,
  audioQualitySchema,
  audioStateSchema,
  computeWebSocketProof,
  createUserSchema,
  loginSchema,
  manualCallsignSchema,
  manualRecognitionSchema,
  nodeLocationSchema,
  persistedRecordSchema,
  publicStatsSchema,
  publicStatusSnapshotSchema,
  radioSignalsSchema,
  reviewSchema,
  speakerRecognitionSchema,
  spotEventSchema,
  spotHistorySchema,
  statusStreamMessageSchema,
  updateUserSchema,
  WEBSOCKET_VERIFICATION_FAILED,
  webSocketChallengeSchema,
  webSocketVerifySchema,
} from './schemas.js'
