import type { CallsignContext, CallsignEvidence } from './callsign-evidence.js'
import type { CallsignModelOutput } from './callsign-model-output.js'
import { isValidCallsign } from '@iaxweb/contracts'

const OWN_PATTERN = /这里是?|我是|我的(?:电台)?呼号(?:是|为)?|\bthis\s+is\b|\bmy\s+call(?:sign)?(?:\s+is)?\b|\bcall\s*是/gi
const OTHER_PATTERN = /(?:[你您他她]|对方).{0,8}呼号|我(?:抄收|拷贝|抄到)|请问.{0,12}(?:呼号|你是|您是)/
const COMPACT_PATTERN = /(?<![A-Z0-9])B[ADGHIY]\d[A-Z]{2,3}(?![A-Z0-9])/gi

export interface CallsignDecision {
  callsign?: string
  evidence?: CallsignEvidence
  error?: string
}

function hasOwnIntroduction(text: string): boolean {
  return new RegExp(OWN_PATTERN.source, 'i').test(text)
}

function isReportedIntroduction(text: string, start: number): boolean {
  return /(?:(?:他|她|对方).{0,4}说|转述|引用)[\s“"'：:]*$/.test(text.slice(Math.max(0, start - 16), start))
}

export function hasCurrentCompactSelfQuote(text: string, quote: string, callsign: string): boolean {
  const at = text.indexOf(quote)
  if (at < 0 || !quote.trim() || OTHER_PATTERN.test(quote))
    return false
  const quoteEnd = at + quote.length
  const introductions = [...text.matchAll(OWN_PATTERN)].map(match => ({ start: match.index, end: match.index + match[0].length }))
  return [...text.matchAll(COMPACT_PATTERN)].some((mention) => {
    if (mention.index < at || mention.index + mention[0].length > quoteEnd || mention[0].toUpperCase() !== callsign)
      return false
    const marker = introductions.filter(item => item.end <= mention.index).at(-1)
    if (marker && marker.start >= at) {
      if (isReportedIntroduction(text, marker.start))
        return false
      const gap = text.slice(marker.end, mention.index)
      return gap.length <= 100 && !OTHER_PATTERN.test(gap) && !new RegExp(COMPACT_PATTERN.source, 'i').test(gap)
    }
    return /\bCQ\b/i.test(quote) && !introductions.some(item => item.start > mention.index)
  })
}

function quoteError(quote: unknown, evidence: CallsignEvidence, context: CallsignContext): string | undefined {
  const { current, history } = context
  if (typeof quote !== 'string' || !quote.trim() || !current.text.includes(quote))
    return 'quote-not-current-verbatim'
  if (OTHER_PATTERN.test(quote))
    return 'quote-refers-to-other'
  const at = current.text.indexOf(quote)
  const quoteEnd = at + quote.length
  const introductions = [...current.text.matchAll(OWN_PATTERN)].map(match => ({ start: match.index, end: match.index + match[0].length }))
  if (evidence.kind === 'verified-continuation') {
    const previous = history.at(-1)
    if (previous && hasOwnIntroduction(previous.text))
      return undefined
    return 'continuation-without-self-introduction'
  }
  if (evidence.segmentId !== current.id) {
    return hasCurrentCompactSelfQuote(current.text, quote, evidence.callsign)
      ? undefined
      : 'history-not-linked-to-current-self'
  }
  const preceding = introductions.filter(marker => marker.end <= evidence.start).at(-1)
  if (preceding) {
    if (isReportedIntroduction(current.text, preceding.start))
      return 'reported-self-introduction'
    const scope = current.text.slice(preceding.end, evidence.start)
    const quotedIntroduction = preceding.start >= at && preceding.end <= quoteEnd
    const mentions = [...quote.matchAll(COMPACT_PATTERN)]
    const includesSpelling = at <= evidence.start && quoteEnd >= evidence.end
    if (quotedIntroduction && !OTHER_PATTERN.test(scope) && scope.length <= 100 && (mentions.length > 0 || includesSpelling)) {
      // A damaged three-letter suffix must not silently become a valid
      // two-letter suffix just because the final explanation word was lost.
      const compact = [...scope.matchAll(COMPACT_PATTERN)].at(-1)?.[0].toUpperCase()
      if (compact?.length === 6 && evidence.callsign.length === 5 && compact.slice(0, 3) === evidence.callsign.slice(0, 3))
        return 'possibly-truncated-suffix'
      return undefined
    }
  }
  if (introductions.some(marker => marker.start > evidence.start))
    return 'candidate-precedes-self-introduction'
  if (/\bCQ\b/i.test(quote) && at <= evidence.start && quoteEnd >= evidence.end)
    return undefined
  const previous = history.at(-1)?.text ?? ''
  const directlyAsked = /(?:请报|报一下|请问|什么|再.{0,4}一下).{0,20}呼号|呼号.{0,20}(?:什么|再|过来)/.test(previous)
  if (directlyAsked && at <= evidence.start && quoteEnd >= evidence.end && !OTHER_PATTERN.test(current.text))
    return undefined
  return 'no-current-self-evidence'
}

export function checkCallsignDecision(result: Record<string, unknown>, context: CallsignContext): CallsignDecision {
  if (result.speaker !== 'self')
    return {}
  const callsign = typeof result.callsign === 'string' ? result.callsign.trim().toUpperCase() : ''
  const evidence = context.candidates.find(candidate => candidate.id === result.evidence && candidate.callsign === callsign)
  if (!isValidCallsign(callsign) || !Number.isInteger(result.evidence) || !evidence)
    return { error: 'invalid-candidate-reference' }
  const error = quoteError(result.quote, evidence, context)
  return error ? { error } : { callsign, evidence }
}

export function checkTextCallsignOutput(output: CallsignModelOutput, context: CallsignContext): string | undefined {
  if (output.speaker === 'self' && output.speakerEvidence.source === 'text' && output.callsignEvidence.source === 'spelling') {
    return checkCallsignDecision({
      speaker: output.speaker,
      callsign: output.callsign,
      quote: output.speakerEvidence.quote,
      evidence: output.callsignEvidence.candidateId,
    }, context).callsign
  }
}

export interface SupportedCallsignEvidence extends CallsignEvidence {
  suggestedQuote: string
}

// This is independent of a model's proposed callsign. Never ask again just
// because extraction failed: both spelling and current identity must exist.
export function supportedSelfEvidence(context: CallsignContext): SupportedCallsignEvidence[] {
  const { current } = context
  const result: SupportedCallsignEvidence[] = []
  for (const evidence of context.candidates) {
    const quotes: string[] = []
    if (evidence.kind === 'verified-continuation') {
      quotes.push(current.text)
    }
    else if (evidence.segmentId === current.id) {
      for (const marker of current.text.matchAll(OWN_PATTERN)) {
        if (marker.index < evidence.start)
          quotes.push(current.text.slice(marker.index, evidence.end))
      }
      const cq = current.text.search(/\bCQ\b/i)
      if (cq >= 0 && cq < evidence.start)
        quotes.push(current.text.slice(cq, evidence.end))
      quotes.push(current.text.slice(0, evidence.end))
    }
    else {
      for (const marker of current.text.matchAll(OWN_PATTERN)) {
        const tail = current.text.slice(marker.index)
        const match = tail.match(new RegExp(`(?<![A-Z0-9])${evidence.callsign}(?![A-Z0-9])`, 'i'))
        if (match)
          quotes.push(tail.slice(0, match.index! + match[0].length))
      }
    }
    const quote = quotes.find(candidate => quoteError(candidate, evidence, context) === undefined)
    if (quote)
      result.push({ ...evidence, suggestedQuote: quote })
  }
  return result
}
