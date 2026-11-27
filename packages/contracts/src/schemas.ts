import { z } from 'zod'
import { CALLSIGN_PATTERN, MANUAL_CALLSIGN_PATTERN, MAX_RECOGNITION_LENGTH } from './callsign.js'

const nonempty = z.string().min(1)
const timestamp = z.iso.datetime()
const publicNodeIdSchema = z.string().regex(/^\d+$/)
const transmitSourceSchema = z.enum(['local', 'remote', 'system']).nullable()
const nodeTypeSchema = z.enum(['HUB', 'REPEATER'])
const adminRoleSchema = z.enum(['admin', 'editor', 'viewer'])
export const adminSessionSchema = z.object({
  role: adminRoleSchema,
  username: nonempty,
  system: z.boolean().optional(),
})
export const adminUsersPageSchema = z.object({ items: z.array(adminSessionSchema) })
export const loginSchema = z.object({ username: nonempty, password: nonempty })
export const manualCallsignSchema = z.object({
  callsign: z.string().trim().toUpperCase().regex(MANUAL_CALLSIGN_PATTERN).nullable(),
})
export const manualRecognitionSchema = z.object({
  recognition: z.string().max(MAX_RECOGNITION_LENGTH).transform(text => text.trim() || null).nullable(),
})
export const reviewSchema = z.object({ reviewed: z.boolean() })
export const createUserSchema = z.object({
  username: z.string().trim().min(1).max(18),
  password: z.string().min(1).max(32),
  role: adminRoleSchema.default('viewer'),
})
export const updateUserSchema = z.object({
  username: z.string().trim().min(1).max(18).optional(),
  password: z.string().min(1).max(32).optional(),
  role: adminRoleSchema.optional(),
}).refine(value => Object.keys(value).length > 0)

export const spotEventSchema = z.object({
  at: timestamp,
  callsign: z.string().regex(MANUAL_CALLSIGN_PATTERN),
  id: nonempty,
  node: nonempty,
  source: publicNodeIdSchema.nullable().optional(),
  type: z.literal('spot').optional(),
})
export const spotHistorySchema = z.array(spotEventSchema)
const statsDaySchema = z.object({
  date: z.iso.date(),
  hourlyCounts: z.array(z.number().int().nonnegative()).length(24),
  voicedMs: z.number().nonnegative(),
})
export const publicStatsSchema = z.object({
  history: z.object({ days: z.array(statsDaySchema).length(30), updatedAt: timestamp }),
  today: z.object({ day: statsDaySchema, updatedAt: timestamp }),
  stale: z.boolean(),
})
export const audioStateSchema = z.object({
  type: z.literal('state'),
  online: z.boolean(),
  speaking: z.boolean(),
  listeners: z.number().int().nonnegative().optional(),
})
const webSocketNonce = z.string().regex(/^[0-9a-f]{32}$/)
export const WEBSOCKET_VERIFICATION_FAILED = 'Verification failed'
export const webSocketChallengeSchema = z.object({ type: z.literal('challenge'), nonce: webSocketNonce })
export const webSocketVerifySchema = z.object({ type: z.literal('verify'), proof: z.string().regex(/^[0-9a-f]{8}$/) })

export function computeWebSocketProof(nonce: string): string {
  // FNV-1a over the ASCII characters of the hexadecimal nonce.
  let hash = 0x811C9DC5
  for (let index = 0; index < nonce.length; index++)
    hash = Math.imul(hash ^ nonce.charCodeAt(index), 0x01000193)
  return (hash >>> 0).toString(16).padStart(8, '0')
}

const publicConnectionStatusSchema = z.object({ CSTATE: z.literal('ESTABLISHED') })
export const nodeLocationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
})
const publicNodeStatusSchema = z.object({
  AI: z.boolean().optional(),
  AI_SPOT: z.boolean().optional(),
  AUDIO: z.boolean().optional(),
  CONNS: z.record(z.string(), publicConnectionStatusSchema).optional(),
  DESC: z.string().optional(),
  FREQ: z.string().optional(),
  GB: z.string().optional(),
  LAST_TX_AT: timestamp.nullable().optional(),
  LINK: z.array(z.string()).optional(),
  LISTENERS: z.number().int().nonnegative().optional(),
  LOCATION: nodeLocationSchema.optional(),
  NAME: z.string().optional(),
  ONLINE: z.boolean().optional(),
  TX_SOURCE: transmitSourceSchema.optional(),
  TYPE: nodeTypeSchema.optional(),
})
export const publicStatusSnapshotSchema = z.record(publicNodeIdSchema, publicNodeStatusSchema)
const publicNodeRuntimeStatusSchema = publicNodeStatusSchema.pick({
  CONNS: true,
  LAST_TX_AT: true,
  LISTENERS: true,
  ONLINE: true,
  TX_SOURCE: true,
}).strict()
export const publicStatusRuntimeSnapshotSchema = z.record(publicNodeIdSchema, publicNodeRuntimeStatusSchema)
export const statusStreamMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot'), nodes: publicStatusSnapshotSchema }),
  z.object({ type: z.literal('state'), nodes: publicStatusRuntimeSnapshotSchema }),
  z.object({ type: z.literal('history'), spots: spotHistorySchema }),
])
const callsign = z.string().regex(CALLSIGN_PATTERN).nullable()
const manualCallsign = z.string().regex(MANUAL_CALLSIGN_PATTERN).nullable()
const radioSignalSchema = z.object({
  type: z.enum(['BSS', 'APRS', 'FleetSync', 'MDC1200', 'DTMF']),
  content: z.string().min(1).max(256),
})
export const radioSignalsSchema = z.array(radioSignalSchema).max(16).readonly()
export const AUDIO_QUALITY_GATE_VERSION = 2
export const AUDIO_INTERFERENCE_REASONS = [
  'interference_tone',
  'interference_high_band',
  'interference_hiss',
  'interference_transient',
  'interference_local',
] as const
const mainsDiagnosticSchema = z.object({
  fundamentalHz: z.union([z.literal(50), z.literal(60)]),
  lines: z.array(z.object({
    nominalHz: z.number().positive(),
    frequencyHz: z.number().positive(),
    medianProminenceDb: z.number(),
    fractionAtLeast12Db: z.number().min(0).max(1),
    p50Dbfs: z.number(),
    relativeVoiceDb: z.number().nullable(),
  })).readonly(),
})
export const audioQualitySchema = z.object({
  status: z.enum(['passed', 'rejected', 'unknown', 'skip']),
  reason: z.string().min(1).max(100).nullable(),
  gateVersion: z.literal(AUDIO_QUALITY_GATE_VERSION).optional(),
  metrics: z.object({
    highBandFraction: z.number().min(0).max(1),
    toneProminenceDb: z.number().nonnegative(),
    highBandRolloffDb: z.number(),
    highBandDynamicDb: z.number().nonnegative(),
    noisePersistenceDb: z.number().nullish(),
    relativeHighFloorDb: z.number().nullish(),
    highBandSpreadDb: z.number().nullish(),
    mainsDiagnostics: z.array(mainsDiagnosticSchema).readonly().nullish(),
  }).nullable(),
})
export const persistedRecordSchema = z.object({
  id: nonempty,
  nodeId: nonempty,
  sourceRepeaterId: publicNodeIdSchema.nullable().optional(),
  capturedAt: timestamp,
  createdAt: timestamp,
  durationMs: z.number().nonnegative(),
  voicedMs: z.number().nonnegative(),
  recognition: z.string(),
  corrected: z.string().nullable(),
  callsign,
  callsignAlgorithm: nonempty.nullable().default(null),
  signaling: radioSignalsSchema.nullable().optional(),
  audioQuality: audioQualitySchema.nullable().optional(),
  manualCallsign,
  calleeCallsign: manualCallsign,
  effectiveCallsign: manualCallsign,
  manualRecognition: z.string().nullable(),
  manualNote: z.string().nullable(),
  reviewed: z.boolean(),
})
const adminRecordSchema = persistedRecordSchema.extend({
  hasAudio: z.boolean(),
  sourceRepeaterName: nonempty.nullable().optional(),
})
export const adminRecordPageSchema = z.object({
  items: z.array(adminRecordSchema),
  page: z.number().int().positive(),
  pageSize: z.number().int().min(1).max(100),
  total: z.number().int().nonnegative(),
})

const speakerMatchSchema = z.object({
  callsign: z.string().regex(CALLSIGN_PATTERN),
  confidence: z.enum(['high', 'medium', 'low']).nullable(),
  count: z.number().int().positive(),
  minSimilarity: z.number().min(-1).max(1),
  maxSimilarity: z.number().min(-1).max(1),
  averageSimilarity: z.number().min(-1).max(1),
  referenceSimilarity: z.number().min(-1).max(1).nullable(),
  referenceRecordCount: z.number().int().min(0).max(16),
  trimmedReferenceSimilarity: z.number().min(-1).max(1).nullable(),
  trimmedReferenceRecordCount: z.number().int().min(0).max(13),
  referenceGroups: z.array(z.object({
    similarity: z.number().min(-1).max(1),
    recordCount: z.number().int().min(2).max(16),
  })).max(4),
})
const measuredMilliseconds = z.number().nonnegative().nullable()
const speakerRecognitionMeasurementsSchema = z.object({
  totalMs: z.number().nonnegative(),
  recordLookupMs: measuredMilliseconds,
  audioReadMs: measuredMilliseconds,
  queueWaitMs: measuredMilliseconds,
  processStartupMs: measuredMilliseconds,
  qualityCheckMs: measuredMilliseconds,
  modelValidationMs: measuredMilliseconds,
  nativeLibraryLoadMs: measuredMilliseconds,
  modelLoadMs: measuredMilliseconds,
  featureExtractionMs: measuredMilliseconds,
  embeddingComputeMs: measuredMilliseconds,
  embeddingNormalizeMs: measuredMilliseconds,
  processExitMs: measuredMilliseconds,
  processTotalMs: measuredMilliseconds,
  databaseSearchMs: measuredMilliseconds,
  referenceLookupMs: measuredMilliseconds,
  referenceMatchMs: measuredMilliseconds,
})
export const speakerRecognitionSchema = z.object({
  recordId: nonempty,
  threshold: z.number().min(-1).max(1),
  status: z.enum(['matched', 'no_match', 'unavailable']),
  reasonCode: z.enum(['record_missing', 'recording_missing', 'recording_invalid', 'insufficient_audio', 'invalid_audio', 'audio_too_long', 'resource_limit', ...AUDIO_INTERFERENCE_REASONS, 'extraction_timeout', 'extraction_busy', 'extraction_failed', 'search_failed', 'empty_reference_library', 'below_threshold']).nullable(),
  reason: z.string().nullable(),
  referenceCount: z.number().int().nonnegative().nullable(),
  matches: z.array(speakerMatchSchema),
  measurements: speakerRecognitionMeasurementsSchema,
})
