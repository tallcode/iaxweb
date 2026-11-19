import type { SpeakerMatch } from '@iaxweb/contracts'
import type { CallsignContext } from './callsign-evidence.js'
import type { CallsignModelOutput } from './callsign-model-output.js'
import { CALLSIGN_PATTERN, CALLSIGN_SOURCE } from '@iaxweb/contracts'
import { recoverSelfSpelling } from './callsign-evidence.js'
import { levenshteinDistance } from './callsign-hints.js'
import { checkTextCallsignOutput, hasCurrentCompactSelfQuote, hasTrailingTruncatedCallsign, supportedSelfEvidence } from './callsign-speaker.js'

const COMPACT_INTRODUCTION = new RegExp(String.raw`(?:这里是|我是|我的(?:电台)?呼号(?:是|为)?|\bthis\s+is\b|\bmy\s+call(?:sign)?(?:\s+is)?\b|\bCQ\b)[\s:：,，]*(${CALLSIGN_SOURCE})(?![A-Z0-9])`, 'gi')
const OTHER_COMPACT_CALLSIGN = new RegExp(String.raw`(?:(?:您|你|对方)的?呼号|我(?:抄收|抄到|拷贝)(?:(?:您|你)的?呼号)?)(?:是|为)?[\s:：]*(${CALLSIGN_SOURCE})(?![A-Z0-9])`, 'gi')

type Match = Pick<SpeakerMatch, 'callsign' | 'confidence'>
type Stage2Match = Pick<Match, 'callsign'> & { id: 1, confidence: 'medium' | 'high' }
interface PreparedStage2 {
  context: CallsignContext
  match: Stage2Match
  review?: CompactReview
}
interface CompactReview {
  compactCallsign: string
  distance: number
  quote: string
  spellingCandidateId: number | null
}
interface CompactIntroduction {
  callsign: string
  start: number
  end: number
}
function uniqueStage2Match(matches: readonly Match[]): Stage2Match | undefined {
  const [match] = matches
  if (matches.length !== 1 || !match || (match.confidence !== 'high' && match.confidence !== 'medium'))
    return undefined
  return { id: 1, callsign: match.callsign, confidence: match.confidence }
}

export function selectStage2Match(context: CallsignContext, matches: readonly Match[]): Stage2Match | undefined {
  const match = uniqueStage2Match(matches)
  if (!match)
    return undefined
  if (match.confidence === 'medium' && !context.candidates.some(candidate => candidate.callsign === match.callsign))
    return undefined
  if (explicitFeatureConflict(context, match.callsign) || supportedSelfEvidence(context).length > 0)
    return undefined
  if (match.confidence === 'medium' && hasExplicitSelfCallsign(context.current.text, match.callsign))
    return undefined
  return match
}

export function prepareStage2(context: CallsignContext, matches: readonly Match[]): PreparedStage2 | undefined {
  const confidence = matches.some(match => match.confidence === 'high') ? 'high' : 'medium'
  const callsigns = [...new Set(matches.filter(match => match.confidence === confidence).map(match => match.callsign))]
  if (callsigns.length === 0)
    return undefined
  const self = currentCompactIntroduction(context.current.text)
  const eligible = callsigns.length > 1 && self
    ? callsigns.filter(callsign => levenshteinDistance(self.callsign, callsign) === 1)
    : callsigns
  const [callsign] = eligible
  if (eligible.length !== 1 || !callsign)
    return undefined
  const match: Stage2Match = { id: 1, callsign, confidence }
  const compact = self && prepareCompactReview(context, match, self)
  if (compact)
    return { ...compact, match }
  // A tie can only enter compact review. If the review vetoes it, do not
  // treat the distance-filtered callsign as an ordinary unique match.
  return callsigns.length === 1 && selectStage2Match(context, [match]) ? { context, match } : undefined
}

export function checkStage2Callsign(
  output: CallsignModelOutput | undefined,
  context: CallsignContext,
  match: Stage2Match,
  review?: CompactReview,
): string | undefined {
  if (!output || output.speaker !== 'self')
    return undefined
  const { callsign, speakerEvidence, callsignEvidence } = output
  if ((speakerEvidence.source === 'featureMatch' && speakerEvidence.matchId !== match.id)
    || (callsignEvidence.source === 'featureMatch' && callsignEvidence.matchId !== match.id)) {
    return undefined
  }
  if (review) {
    // The model must cite the same-utterance candidate chosen by the server.
    return callsign === match.callsign && speakerEvidence.source === 'featureMatch'
      && callsignEvidence.source === 'spelling' && callsignEvidence.candidateId === review.spellingCandidateId
      && context.candidates.some(candidate => candidate.id === review.spellingCandidateId && candidate.callsign === callsign
        && !hasTrailingTruncatedCallsign(context, candidate))
      ? callsign
      : undefined
  }
  if (speakerEvidence.source === 'text' && callsignEvidence.source === 'spelling')
    return checkTextCallsignOutput(output, context)
  if (callsign !== match.callsign)
    return undefined
  if (speakerEvidence.source === 'text') {
    if (!hasCurrentCompactSelfQuote(context.current.text, speakerEvidence.quote, callsign))
      return undefined
  }
  else if (hasExplicitSelfCallsign(context.current.text, callsign)) {
    return undefined
  }
  if (callsignEvidence.source === 'spelling') {
    return context.candidates.some(candidate => candidate.id === callsignEvidence.candidateId && candidate.callsign === callsign
      && !hasTrailingTruncatedCallsign(context, candidate))
      ? callsign
      : undefined
  }
  if (match.confidence !== 'high' || context.candidates.some(candidate => candidate.callsign === callsign))
    return undefined
  return callsign
}

function hasExplicitSelfCallsign(text: string, callsign: string): boolean {
  return compactIntroductions(text).some(match => match[1]!.toUpperCase() === callsign
    && hasCurrentCompactSelfQuote(text, match[0], callsign))
}

function compactIntroductions(text: string) {
  return [...text.matchAll(COMPACT_INTRODUCTION)]
}

function currentCompactIntroduction(text: string): CompactIntroduction | undefined {
  const introductions = compactIntroductions(text)
    .filter(entry => hasCurrentCompactSelfQuote(text, entry[0], entry[1]!.toUpperCase()))
  const [self] = introductions
  if (introductions.length !== 1 || !self)
    return undefined
  return { callsign: self[1]!.toUpperCase(), start: self.index, end: self.index + self[0].length }
}

function explicitFeatureConflict(context: CallsignContext, callsign: string): boolean {
  const { current: { text } } = context
  const conflictingSelf = compactIntroductions(text).some(match => match[1]!.toUpperCase() !== callsign
    && hasCurrentCompactSelfQuote(text, match[0], match[1]!.toUpperCase()))
  return conflictingSelf || explicitOtherFeatureUse(context, callsign)
}

function explicitOtherFeatureUse(context: CallsignContext, callsign: string): boolean {
  const { current: { id, text }, candidates } = context
  if ([...text.matchAll(OTHER_COMPACT_CALLSIGN)].some(match => match[1]!.toUpperCase() === callsign))
    return true
  const otherSpelling = /(?:(?:您|你|对方)的?呼号|我(?:抄收|抄到|拷贝)(?:(?:您|你)的?呼号)?)(?:是|为)?[\s:：]*$/
  return candidates.some(candidate => candidate.segmentId === id && candidate.callsign === callsign
    && otherSpelling.test(text.slice(0, candidate.start)))
}

function prepareCompactReview(context: CallsignContext, match: Stage2Match, self: CompactIntroduction): { context: CallsignContext, review: CompactReview } | undefined {
  const { current } = context
  const { text } = current
  if (!CALLSIGN_PATTERN.test(match.callsign))
    return undefined
  const { callsign: compactCallsign, start, end } = self
  const distance = levenshteinDistance(compactCallsign, match.callsign)
  // An exact match continues through ordinary Stage 2 evidence rules.
  if (distance !== 1 || explicitOtherFeatureUse(context, match.callsign))
    return undefined

  const boundary = text.slice(end).search(/[。！？；.!?;\r\n]/u)
  const scopeEnd = boundary < 0 ? text.length : end + boundary
  const sameSelf = text.slice(start, scopeEnd)
  const literalMatch = new RegExp(`(?<![A-Z0-9])${match.callsign}(?![A-Z0-9])`, 'i')
  if (literalMatch.test(text.slice(0, start)) || /您的?呼号|你的?呼号|对方的?呼号|我(?:抄收|拷贝|抄到)/u.test(sameSelf))
    return undefined
  const scoped = context.candidates.filter(candidate => candidate.segmentId === current.id
    && candidate.kind !== 'verified-continuation' && candidate.start >= end && candidate.end <= scopeEnd)
  // A candidate must follow the self-call directly. A split prefix belongs
  // to the same evidence only if its verbatim quote also falls inside this scope.
  const adjacent = scoped.filter((candidate) => {
    const gap = text.slice(end, candidate.start)
    const prefix = candidate.kind === 'prefix-and-suffix' && candidate.prefixQuote
    const beforePrefix = prefix ? gap.lastIndexOf(prefix) : gap.length
    const afterPrefix = prefix ? gap.slice(beforePrefix + prefix.length) : ''
    return beforePrefix >= 0 && candidate.end - start <= 100
      && /^[\s，,:：-]*(?:(?:尾号|后缀|字母解释法|拼读)(?:是|为)?[\s，,:：-]*)?$/u.test(gap.slice(0, beforePrefix))
      && /^[\s，,:：]*$/u.test(afterPrefix)
  })
  const recovered = scoped.length === 0 ? recoverSelfSpelling(current, compactCallsign, end, context.candidates.length + 1) : undefined
  const candidate = scoped.length === 1 ? adjacent[0] : recovered && recovered.end - start <= 100 ? recovered : undefined
  return {
    context: candidate && candidate === recovered ? { ...context, candidates: [...context.candidates, candidate] } : context,
    review: {
      compactCallsign,
      distance,
      quote: candidate ? text.slice(start, candidate.end) : sameSelf,
      spellingCandidateId: candidate?.id ?? null,
    },
  }
}
