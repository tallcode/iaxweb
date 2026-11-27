import { CALLSIGN_PATTERN, CALLSIGN_SOURCE } from '@iaxweb/contracts'
import { distance } from 'fastest-levenshtein'

export type Confidence = 'low' | 'medium' | 'high'
export type Kind = 'compact' | 'spelling' | 'feature' | 'tail'
export interface Span { sourceId: string, start: number, end: number }
export interface Candidate {
  callsign: string
  confidence: Confidence
  kind: Kind
  spans: Span[]
}
export interface Signal { type: string, content: string, crcValid?: boolean }
export interface Input {
  eligible: boolean
  // Preserve the fact that an invalid/unsupported self report existed.
  hadSelf: boolean
  selves: Candidate[]
  spellings: Candidate[]
  features: Candidate[]
  signals: Signal[]
}
export interface Step {
  source: 'spelling' | 'feature' | 'tail'
  maxDistance: number
  matched: string[]
  ambiguityBefore: string[] | null
  comparisons: Array<{ self: string, reference: string, distance: number, independent: boolean }>
}
export interface Decision {
  callsign: string | null
  reason: string
  selfOrigin: 'self' | 'feature' | null
  effectiveSelfConfidence: Confidence | null
  selected: { self: string[], spelling: string[], feature: string[], tail: string[] }
  steps: Step[]
}
export interface DecisionOptions {
  // A partial-source caller may confirm exact evidence, but must wait for all
  // sources before allowing a compact self-report to be corrected.
  allowCompactCorrection?: boolean
}

const rank = { low: 1, medium: 2, high: 3 } as const
const calls = (items: readonly Candidate[]) => [...new Set(items.map(item => item.callsign))].sort()
const isFull = (callsign: string) => CALLSIGN_PATTERN.test(callsign)
// A valid suffix is separate from a damaged full-looking callsign. Do not turn
// BG5FGBR/BG5G1 into a suffix or search a valid substring inside them.
const isSuffix = (callsign: string) => /^(?:[A-Z]{3}|\d[A-Z]{2,3})$/.test(callsign)
const downgrade = (level: Confidence): Confidence | null => level === 'high' ? 'medium' : level === 'medium' ? 'low' : null

function highest(items: readonly Candidate[]): Candidate[] {
  const max = Math.max(0, ...items.map(item => rank[item.confidence]))
  // Keep provenance alternatives for repeated callsigns; count DISTINCT calls
  // rather than dropping independent evidence from another historical quote.
  return items.filter(item => rank[item.confidence] === max)
}

export function tailCandidates(signals: readonly Signal[]): Candidate[] {
  const found = new Set<string>()
  const ssid = String.raw`-(?:[0-9]|1[0-5])`
  const portable = String.raw`/(?:P|M|MM|AM|QRP)`
  const ordinary = new RegExp(`^(${CALLSIGN_SOURCE})(?:${ssid})?(?:${portable})?$`)
  const reversed = new RegExp(`^(${CALLSIGN_SOURCE})${portable}${ssid}$`)
  for (const signal of signals) {
    if (!['BSS', 'APRS'].includes(signal.type) || signal.crcValid === false)
      continue
    const raw = signal.content.trim().toUpperCase()
    // Explicit suffix whitelist, anchored at the end. Never split arbitrary
    // comments, paths, unknown suffixes, or out-of-range APRS SSIDs.
    // At most one SSID and one operation suffix, in either order. A repeated
    // suffix such as -1-2 or /P/P is malformed, not two things to trim away.
    const call = (ordinary.exec(raw) ?? reversed.exec(raw))?.[1]
    if (call && isFull(call))
      found.add(call)
  }
  return [...found].sort().map(callsign => ({ callsign, confidence: 'medium', kind: 'tail', spans: [] }))
}

function independent(left: Candidate, right: Candidate): boolean {
  // Only the character spans matter: two different forms in one message may
  // corroborate each other, but two views of the SAME words may not.
  return !left.spans.some(a => right.spans.some(b => a.sourceId === b.sourceId
    && a.start < b.end && b.start < a.end))
}

function callDistance(self: string, reference: string): number {
  return distance(self, isFull(self) ? reference : reference.slice(-self.length))
}

export function decide(input: Input, options: DecisionOptions = {}): Decision {
  const self = highest(input.selves
    .filter(item => isFull(item.callsign) || isSuffix(item.callsign))
    .map(item => item.kind === 'compact' && item.confidence === 'high' ? { ...item, confidence: 'medium' as const } : item))
  const spelling = highest(input.spellings.filter(item => isFull(item.callsign)))
  const feature = highest(input.features.filter(item => isFull(item.callsign)))
  const tail = tailCandidates(input.signals)
  const result: Decision = {
    callsign: null,
    reason: 'no_support',
    selfOrigin: null,
    effectiveSelfConfidence: null,
    selected: { self: calls(self), spelling: calls(spelling), feature: calls(feature), tail: calls(tail) },
    steps: [],
  }
  if (!input.eligible)
    return { ...result, reason: 'entry_gate_skipped' }

  let anchors = self
  let level = self[0]?.confidence ?? null
  const origin = input.hadSelf || self.length > 0 ? 'self' : 'feature'
  result.selfOrigin = origin
  if (origin === 'self') {
    if (!anchors.length)
      return { ...result, reason: 'invalid_self_not_missing' }
    if (calls(anchors).length === 1 && level === 'high'
      && anchors.some(item => item.kind === 'spelling' && isFull(item.callsign))) {
      return { ...result, callsign: anchors[0]!.callsign, reason: 'unique_high_spelled_self', effectiveSelfConfidence: 'high' }
    }
    if (calls(anchors).length > 1 || anchors.some(item => !isFull(item.callsign)))
      level = downgrade(level!)
    if (!level)
      return { ...result, reason: 'self_downgraded_to_empty' }
  }
  else {
    anchors = feature
    level = feature[0] ? downgrade(feature[0].confidence) : null
    if (!level)
      return { ...result, reason: 'no_usable_feature_substitute' }
    // Substitution incurs exactly one source downgrade, not an additional
    // multiplicity downgrade. Feature evidence cannot then vote for itself.
  }
  result.effectiveSelfConfidence = level
  const eligible = (items: Candidate[]) => items.filter(item => level === 'low' ? item.confidence === 'high' : item.confidence !== 'low')
  const stages: Array<{ source: Step['source'], items: Candidate[] }> = [
    { source: 'spelling', items: eligible(spelling) },
    ...(origin === 'self' ? [{ source: 'feature' as const, items: eligible(feature) }] : []),
    ...(level !== 'low' ? [{ source: 'tail' as const, items: tail }] : []),
  ]
  let ambiguity: Set<string> | undefined
  const canCorrect = options.allowCompactCorrection !== false && origin === 'self'
    && level === 'medium' && anchors.some(anchor => anchor.kind === 'compact')
  // All exact sources outrank every approximate source. Only a compact self
  // can enter the second pass; reference calls and other anchor kinds are fixed.
  const passes = canCorrect ? [0, 1] : [0]
  for (const maxDistance of passes) {
    const passAnchors = maxDistance === 0 ? anchors : anchors.filter(anchor => anchor.kind === 'compact')
    for (const stage of stages) {
      const comparisons: Step['comparisons'] = []
      const matches = new Set<string>()
      for (const reference of stage.items) {
        if (ambiguity && !ambiguity.has(reference.callsign))
          continue
        // Medium-confidence spellings may corroborate an exact call, but
        // only high-confidence spellings may correct a compact self report.
        const allowedDistance = stage.source === 'spelling' && reference.confidence !== 'high' ? 0 : maxDistance
        for (const anchor of passAnchors) {
          const editDistance = callDistance(anchor.callsign, reference.callsign)
          const separate = independent(anchor, reference)
          comparisons.push({ self: anchor.callsign, reference: reference.callsign, distance: editDistance, independent: separate })
          if (separate && editDistance <= allowedDistance)
            matches.add(reference.callsign)
        }
      }
      const matched = [...matches].sort()
      result.steps.push({ source: stage.source, maxDistance, matched, ambiguityBefore: ambiguity ? [...ambiguity].sort() : null, comparisons })
      if (matched.length === 1)
        return { ...result, callsign: matched[0]!, reason: `${origin}_${level}_with_${stage.source}` }
      if (matched.length > 1)
        ambiguity = matches
    }
  }
  return { ...result, reason: ambiguity ? 'unresolved_ambiguity' : 'no_support' }
}
