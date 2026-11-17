import type { z } from 'zod'
import type {
  adminRecordPageSchema,
  adminRecordSchema,
  adminRoleSchema,
  adminSessionSchema,
  adminUsersPageSchema,
  audioStateSchema,
  createUserSchema,
  loginSchema,
  manualCallsignSchema,
  manualRecognitionSchema,
  nodeTypeSchema,
  persistedRecordSchema,
  publicConnectionStatusSchema,
  publicNodeStatusSchema,
  publicStatusSnapshotSchema,
  recordPageSchema,
  reviewSchema,
  spotEventSchema,
  transmitSourceSchema,
  updateUserSchema,
} from './schemas.js'

export type TransmitSource = z.output<typeof transmitSourceSchema>
export type NodeType = z.output<typeof nodeTypeSchema>
export type AdminRole = z.output<typeof adminRoleSchema>
export type AdminSession = z.output<typeof adminSessionSchema>
export type AdminUsersPage = z.output<typeof adminUsersPageSchema>
export type PublicConnectionStatus = z.output<typeof publicConnectionStatusSchema>
export type PublicNodeStatus = z.output<typeof publicNodeStatusSchema>
export type PublicStatusSnapshot = z.output<typeof publicStatusSnapshotSchema>
export type SpotEvent = z.output<typeof spotEventSchema>
export type AudioState = z.output<typeof audioStateSchema>
export type PersistedRecord = z.output<typeof persistedRecordSchema>
export type RecordPage = z.output<typeof recordPageSchema>
export type AdminRecord = z.output<typeof adminRecordSchema>
export type AdminRecordPage = z.output<typeof adminRecordPageSchema>
export type LoginInput = z.input<typeof loginSchema>
export type CreateUserInput = z.input<typeof createUserSchema>
export type UpdateUserInput = z.input<typeof updateUserSchema>
export type ManualCallsignInput = z.input<typeof manualCallsignSchema>
export type ManualRecognitionInput = z.input<typeof manualRecognitionSchema>
export type ManualRecognition = z.output<typeof manualRecognitionSchema>
export type ReviewInput = z.input<typeof reviewSchema>

export * from './callsign.js'
export * from './schemas.js'
