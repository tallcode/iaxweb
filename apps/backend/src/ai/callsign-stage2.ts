import type { SpeakerMatch } from '@iaxweb/contracts'
import type { CallsignExtraction } from './callsign-extraction.js'
import { isValidCallsign } from '@iaxweb/contracts'
import { distance } from 'fastest-levenshtein'
import { matchExtractedCallsign } from './callsign-extraction.js'

type FeatureMatch = Pick<SpeakerMatch, 'callsign' | 'confidence'>

// Stage 1 must return a validated extraction. No model call or role inference.
export function matchFeatureCallsign(extraction: CallsignExtraction, matches: readonly FeatureMatch[]): string | undefined {
  const first = matchExtractedCallsign(extraction)
  if (first)
    return first
  const self = extraction.selfCallsign
  const spelling = new Set(extraction.spelledCallsigns)
  if (!self && spelling.size === 0)
    return undefined
  const confidence = matches.some(match => match.confidence === 'high')
    ? 'high'
    : matches.some(match => match.confidence === 'medium') ? 'medium' : undefined
  if (!confidence || (spelling.size === 0 && confidence !== 'high'))
    return undefined
  // Select the highest tier before filtering; never fall back to a lower tier.
  // Spelling always requires an exact, prefix-inclusive match.
  const selected = [...new Set(matches
    .filter(match => match.confidence === confidence && isValidCallsign(match.callsign))
    .map(match => match.callsign))]
  const suffix = self ? self.replace(/^[A-Z]{2}(?=\d)/, '') : null
  if (suffix !== null && suffix.length < 3)
    return undefined
  // Known limitation, deferred by the user: null self cannot distinguish a
  // missing self-introduction from explicitly repeating the other station.
  const eligible = selected.filter(call => (spelling.size === 0 || spelling.has(call))
    && (suffix === null || distance(suffix, call.slice(2).slice(-suffix.length)) <= 1))
  return eligible.length === 1 ? eligible[0] : undefined
}
