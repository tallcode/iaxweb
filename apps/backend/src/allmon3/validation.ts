import type { NodeStatus } from './types.js'
import { z } from 'zod'

export const nodeIdsSchema = z.array(z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/).transform(Number)]))
export const overridesSchema = z.record(z.string(), z.string())
export const nodeConfigSchema = z.object({
  statport: z.number().int().min(1).max(65_535),
  cmdport: z.number().int().min(1).max(65_535).optional(),
})
const statusSchema = z.object({
  CONNS: z.record(z.string(), z.record(z.string(), z.json())).optional(),
  DESC: z.string().optional(),
  NAME: z.string().optional(),
  FREQ: z.string().optional(),
  GB: z.string().optional(),
  AUDIO: z.boolean().optional(),
  AI: z.boolean().optional(),
  ME: z.number().optional(),
  RXKEYED: z.boolean().optional(),
  TXKEYED: z.boolean().optional(),
  TXEKEYED: z.boolean().optional(),
  CONNKEYED: z.boolean().optional(),
  CONNKEYEDNODE: z.union([z.boolean(), z.number(), z.string()]).optional(),
}).catchall(z.json())

export function parseNodeStatus(value: unknown): NodeStatus | undefined {
  const parsed = statusSchema.safeParse(value)
  return parsed.success ? parsed.data as NodeStatus : undefined
}
