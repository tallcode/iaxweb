import { isValidCallsign } from '@iaxweb/contracts'

export interface RiskRating {
  level: number
  reason: string
}

export interface TranscriptAnalysis {
  message?: string | undefined
  risk?: RiskRating | undefined
}

interface FeatureMatchEvidence {
  source: 'featureMatch'
  matchId: number
}

export type CallsignModelOutput = TranscriptAnalysis & (
  | { speaker: 'other' | 'unknown' }
  | {
    speaker: 'self'
    callsign: string
    speakerEvidence: { source: 'text', quote: string } | FeatureMatchEvidence
    callsignEvidence: { source: 'spelling', candidateId: number } | FeatureMatchEvidence
  }
)

function modelObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function featureMatchEvidence(evidence: Record<string, unknown> | undefined): FeatureMatchEvidence | undefined {
  if (evidence?.source === 'featureMatch' && positiveInteger(evidence.matchId))
    return { source: 'featureMatch', matchId: evidence.matchId }
}

export function readCallsignModelOutput(value: Record<string, unknown>): CallsignModelOutput | undefined {
  const { speaker, callsign } = value
  const analysis: TranscriptAnalysis = {}
  if (typeof value.message === 'string')
    analysis.message = value.message
  const risk = modelObject(value.risk)
  if (risk && positiveInteger(risk.level) && risk.level <= 5 && typeof risk.reason === 'string')
    analysis.risk = { level: risk.level, reason: risk.reason }
  if (speaker === 'unknown' || speaker === 'other')
    return { speaker, ...analysis }
  if (speaker !== 'self' || typeof callsign !== 'string' || !isValidCallsign(callsign))
    return undefined

  const identity = modelObject(value.speakerEvidence)
  const spelling = modelObject(value.callsignEvidence)
  const speakerEvidence = identity?.source === 'text' && typeof identity.quote === 'string' && identity.quote.trim()
    ? { source: 'text' as const, quote: identity.quote }
    : featureMatchEvidence(identity)
  const callsignEvidence = spelling?.source === 'spelling' && positiveInteger(spelling.candidateId)
    ? { source: 'spelling' as const, candidateId: spelling.candidateId }
    : featureMatchEvidence(spelling)
  if (speakerEvidence && callsignEvidence)
    return { speaker, callsign, speakerEvidence, callsignEvidence, ...analysis }
}
