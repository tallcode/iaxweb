import type { SpeakerReferenceGroup, SpeakerReferenceScore, Voiceprint } from '../records/types.js'
import { SPEAKER_DIMENSIONS, SPEAKER_VERSION } from './speaker-model.mjs'

export type SpeakerRequest = { operation: 'extract', samples: Float32Array, qualityApproved?: boolean }
  | { operation: 'references', embedding: Float32Array, groups: SpeakerReferenceGroup[] }
export type SpeakerResult = Voiceprint | SpeakerReferenceScore[]

export interface SpeakerWorkerMessage {
  requestId?: number
  event?: string
  stage?: string
  durationMs?: number
  status?: string
  reason?: string
  embedding?: Float32Array
  scores?: unknown
  version?: string
  error?: string
  rss?: number
}

export function parseSpeakerResult(request: SpeakerRequest, message: SpeakerWorkerMessage): SpeakerResult | undefined {
  if (request.operation === 'references')
    return validReferenceScores(message.scores, request.groups) ? message.scores : undefined
  if (message.status === 'unavailable' && !message.embedding && typeof message.reason === 'string' && message.reason.length > 0)
    return { status: 'unavailable', version: SPEAKER_VERSION, reason: message.reason }
  if (message.embedding instanceof Float32Array && validEmbedding(message.embedding))
    return { status: 'ready', version: SPEAKER_VERSION, embedding: message.embedding }
}

function validReferenceScores(scores: unknown, groups: SpeakerReferenceGroup[]): scores is SpeakerReferenceScore[] {
  return Array.isArray(scores) && scores.length === groups.length && scores.every((score, index) => {
    const group = groups[index]!
    const count = group.embeddings.length
    return score && score.callsign === group.callsign
      && validReferenceScore(score.referenceSimilarity, score.referenceRecordCount, count)
      && validReferenceScore(score.trimmedReferenceSimilarity, score.trimmedReferenceRecordCount, count - Math.floor(count / 5))
      && validReferenceGroups(score.referenceGroups, count)
  })
}

function validReferenceScore(similarity: unknown, count: unknown, expectedCount: number): boolean {
  return similarity === null
    ? count === 0
    : typeof similarity === 'number'
      && similarity >= -1 && similarity <= 1 && count === expectedCount && expectedCount > 0
}

function validReferenceGroups(groups: unknown, total: number): boolean {
  if (!Array.isArray(groups) || groups.length > 4)
    return false
  if (total < 5)
    return groups.length === 0
  let count = 0
  for (const group of groups) {
    if (!group || typeof group.similarity !== 'number' || !(group.similarity >= -1 && group.similarity <= 1)
      || !Number.isInteger(group.recordCount) || group.recordCount * 5 <= total || group.recordCount > total) {
      return false
    }
    count += group.recordCount
  }
  return count <= total
}

export function validEmbedding(embedding: Float32Array): boolean {
  if (embedding.length !== SPEAKER_DIMENSIONS)
    return false
  let norm = 0
  for (const value of embedding) {
    if (!Number.isFinite(value))
      return false
    norm += value * value
  }
  return norm > 0 && Number.isFinite(norm)
}
