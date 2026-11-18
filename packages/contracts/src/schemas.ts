import { z } from 'zod'
import { CALLSIGN_PATTERN, MANUAL_CALLSIGN_PATTERN, MAX_RECOGNITION_LENGTH } from './callsign.js'

const nonempty = z.string().min(1)
const timestamp = z.iso.datetime()
export const transmitSourceSchema = z.enum(['local', 'remote', 'system']).nullable()
export const nodeTypeSchema = z.enum(['HUB', 'REPEATER'])
export const adminRoleSchema = z.enum(['admin', 'editor', 'viewer'])
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
  type: z.literal('spot').optional(),
})
export const spotHistorySchema = z.array(spotEventSchema)
export const audioStateSchema = z.object({
  type: z.literal('state'),
  online: z.boolean(),
  speaking: z.boolean(),
  listeners: z.number().int().nonnegative().optional(),
})
export const publicConnectionStatusSchema = z.object({ CSTATE: z.literal('ESTABLISHED') })
export const publicNodeStatusSchema = z.object({
  AI: z.boolean().optional(),
  AUDIO: z.boolean().optional(),
  CONNS: z.record(z.string(), publicConnectionStatusSchema).optional(),
  DESC: z.string().optional(),
  FREQ: z.string().optional(),
  GB: z.string().optional(),
  LAST_TX_AT: timestamp.nullable().optional(),
  LINK: z.array(z.string()).optional(),
  LISTENERS: z.number().int().nonnegative().optional(),
  NAME: z.string().optional(),
  ONLINE: z.boolean().optional(),
  TX_SOURCE: transmitSourceSchema.optional(),
  TYPE: nodeTypeSchema.optional(),
})
export const publicStatusSnapshotSchema = z.record(z.string().regex(/^\d+$/), publicNodeStatusSchema)
const callsign = z.string().regex(CALLSIGN_PATTERN).nullable()
const manualCallsign = z.string().regex(MANUAL_CALLSIGN_PATTERN).nullable()
const riskLevel = z.number().int().min(1).max(5).nullable()
export const persistedRecordSchema = z.object({
  id: nonempty,
  nodeId: nonempty,
  capturedAt: timestamp,
  createdAt: timestamp,
  durationMs: z.number().nonnegative(),
  voicedMs: z.number().nonnegative(),
  recognition: z.string(),
  corrected: z.string().nullable(),
  revise: z.string().nullable(),
  callsign,
  manualCallsign,
  calleeCallsign: manualCallsign,
  effectiveCallsign: manualCallsign,
  manualRecognition: z.string().nullable(),
  manualNote: z.string().nullable(),
  riskLevel,
  manualRiskLevel: riskLevel,
  effectiveRiskLevel: riskLevel,
  riskReason: z.string().nullable(),
  reviewed: z.boolean(),
})
export const recordPageSchema = z.object({
  items: z.array(persistedRecordSchema),
  page: z.number().int().positive(),
  pageSize: z.number().int().min(1).max(100),
  total: z.number().int().nonnegative(),
})
export const adminRecordSchema = persistedRecordSchema.extend({ hasAudio: z.boolean() })
export const adminRecordPageSchema = recordPageSchema.extend({ items: z.array(adminRecordSchema) })

export const speakerMatchSchema = z.object({
  callsign: z.string().regex(CALLSIGN_PATTERN),
  count: z.number().int().positive(),
  minSimilarity: z.number().min(-1).max(1),
  maxSimilarity: z.number().min(-1).max(1),
  averageSimilarity: z.number().min(-1).max(1),
})
export const speakerRecognitionSchema = z.object({
  recordId: nonempty,
  threshold: z.number().min(-1).max(1),
  status: z.enum(['matched', 'no_match', 'unavailable']),
  reasonCode: z.enum(['record_missing', 'recording_missing', 'recording_invalid', 'insufficient_audio', 'invalid_audio', 'audio_too_long', 'resource_limit', 'interference_tone', 'interference_high_band', 'extraction_timeout', 'extraction_busy', 'extraction_failed', 'search_failed', 'empty_reference_library', 'below_threshold']).nullable(),
  reason: z.string().nullable(),
  referenceCount: z.number().int().nonnegative().nullable(),
  matches: z.array(speakerMatchSchema),
})
