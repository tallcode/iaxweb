import type { RadioSignal, SpeakerMatch } from '@iaxweb/contracts'
import type { TranscriptTurn } from './callsign-evidence.js'
import type { Candidate, Confidence, Decision, Input, Span } from './callsign-policy.js'
import { decide } from './callsign-policy.js'
import { deriveStandardSpelling, validSpelling } from './callsign-spelling.js'
import { correctExplanationText } from './phonetic-corrector.js'
import { compileSchema } from './schema-validator.js'

export interface CallsignExtraction {
  selfCallsigns: Array<{
    identityEvidence: string
    quote: string
    type: 'compact' | 'spelling'
    callsign: string | null
    confidence: Confidence
  }>
  spelledCallsigns: Array<{
    sourceId: string
    quote: string
    correctedSpelling: string
    callsign: string | null
    confidence: Confidence
  }>
}

export interface PreparedCallsignExtraction {
  extraction: CallsignExtraction
  hadSelf: boolean
  input: Input
}

export interface CallsignResolution {
  callsign?: string
  algorithm?: 'stage1_text' | 'stage2_feature'
  decision: Decision
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

// Do not call the model with the previous scalar-output schema. A valid JSON
// Schema alone does not establish compatibility with this extraction contract.
export function isCallsignExtractionSchema(schema: Record<string, unknown>): boolean {
  const properties = object(schema.properties)
  const required = schema.required
  if (schema.type !== 'object' || schema.additionalProperties !== false || !properties || Object.keys(properties).length !== 2
    || !Array.isArray(required)
    || !required.includes('selfCallsigns') || !required.includes('spelledCallsigns')) {
    return false
  }
  for (const [name, fields] of [
    ['selfCallsigns', ['identityEvidence', 'quote', 'type', 'callsign', 'confidence']],
    ['spelledCallsigns', ['sourceId', 'quote', 'correctedSpelling', 'callsign', 'confidence']],
  ] as const) {
    const array = object(properties?.[name])
    const item = object(array?.items)
    const itemProperties = object(item?.properties)
    const itemRequired = item?.required
    if (array?.type !== 'array' || item?.type !== 'object' || item.additionalProperties !== false
      || !itemProperties || Object.keys(itemProperties).length !== fields.length || !Array.isArray(itemRequired)
      || fields.some(field => !itemRequired.includes(field) || !object(itemProperties[field]))) {
      return false
    }
    for (const field of fields) {
      const definition = object(itemProperties[field])!
      const types = Array.isArray(definition.type) ? definition.type : [definition.type]
      const expected = field === 'callsign' ? ['string', 'null'] : ['string']
      if (types.length !== expected.length || expected.some(type => !types.includes(type)))
        return false
    }
    const confidence = object(itemProperties.confidence)!.enum
    if (!Array.isArray(confidence) || confidence.length !== 3
      || !['high', 'medium', 'low'].every(level => confidence.includes(level))) {
      return false
    }
    if (name === 'selfCallsigns') {
      const kinds = object(itemProperties.type)!.enum
      if (!Array.isArray(kinds) || kinds.length !== 2 || !['compact', 'spelling'].every(kind => kinds.includes(kind)))
        return false
    }
  }
  return true
}

const shapeValidators = new WeakMap<Record<string, unknown>, (value: unknown) => string | undefined>()

function shapeValidator(schema: Record<string, unknown>): ((value: unknown) => string | undefined) | undefined {
  if (!isCallsignExtractionSchema(schema))
    return undefined
  const cached = shapeValidators.get(schema)
  if (cached)
    return cached
  // Format failures are removed per candidate; all unknown fields, missing
  // fields and wrong value types still invalidate the entire response.
  const shape = structuredClone(schema)
  const properties = object(shape.properties)!
  for (const key of ['selfCallsigns', 'spelledCallsigns']) {
    const item = object(object(properties[key])!.items)!
    const fields = object(item.properties)!
    delete object(fields.callsign)!.pattern
  }
  try {
    const validate = compileSchema(shape)
    shapeValidators.set(schema, validate)
    return validate
  }
  catch {
    return undefined
  }
}

function compactCharacters(quote: string): string {
  const digits: Record<string, string> = Object.fromEntries('ZERO ONE TWO THREE FOUR FIVE SIX SEVEN EIGHT NINE'.split(' ').map((word, n) => [word, String(n)]))
  const chinese: Record<string, string> = { 零: '0', 洞: '0', 一: '1', 幺: '1', 二: '2', 两: '2', 三: '3', 四: '4', 五: '5', 六: '6', 七: '7', 拐: '7', 八: '8', 九: '9', 勾: '9' }
  return quote.normalize('NFKC').toUpperCase().replace(/\b(?:ZERO|ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE)\b/g, word => digits[word]!).replace(/[零洞一幺二两三四五六七拐八九勾]/g, word => chinese[word]!).replace(/[\s,，.。:：;；、-]/g, '')
}

function spans(turn: TranscriptTurn | undefined, quote: string): Span[] {
  if (!turn || !quote)
    return []
  const result: Span[] = []
  let start = turn.text.indexOf(quote)
  while (start >= 0) {
    result.push({ sourceId: turn.id, start, end: start + quote.length })
    start = turn.text.indexOf(quote, start + 1)
  }
  return result
}

function selfCandidate(entry: CallsignExtraction['selfCallsigns'][number], current: TranscriptTurn, spelling: CallsignExtraction['spelledCallsigns']): Candidate | undefined {
  const evidence = spans(current, entry.quote)
  const identities = spans(current, entry.identityEvidence)
  const anchored = identities.some(a => evidence.some(b => a.end <= b.start))
  const linked = entry.type === 'compact'
    ? compactCharacters(entry.quote) === entry.callsign
    : spelling.some(item => item.sourceId === current.id && item.quote === entry.quote
      && item.callsign === entry.callsign && item.confidence === entry.confidence)
  if (!entry.callsign || !anchored || !linked)
    return undefined
  return { callsign: entry.callsign, confidence: entry.confidence, kind: entry.type, spans: evidence }
}

function cleanEvidence(raw: CallsignExtraction, current: TranscriptTurn): CallsignExtraction {
  const spelling = raw.spelledCallsigns.filter(validSpelling)
  function occurrences(entry: CallsignExtraction['selfCallsigns'][number]): Array<{ quote: number, anchor: number }> {
    const found: Array<{ quote: number, anchor: number }> = []
    let quote = current.text.indexOf(entry.quote)
    while (quote >= 0) {
      const anchor = current.text.lastIndexOf(entry.identityEvidence, quote)
      if (anchor >= 0 && anchor + entry.identityEvidence.length <= quote)
        found.push({ quote, anchor })
      quote = current.text.indexOf(entry.quote, quote + 1)
    }
    return found
  }
  // Use model-supplied verbatim anchor positions rather than enumerating
  // possible self-introduction phrases. Separate introductions remain separate.
  const compact = raw.selfCallsigns.filter(entry => entry.type === 'compact' && selfCandidate(entry, current, []))
  const selves = raw.selfCallsigns.filter((entry) => {
    const positions = occurrences(entry)
    const redundant = entry.type === 'spelling' && positions.length > 0
      && positions.every(position => compact.some(bare => occurrences(bare).some(before => before.anchor === position.anchor)))
    return !redundant
  })
  return { selfCallsigns: selves, spelledCallsigns: spelling }
}

export function prepareCallsignExtraction(value: unknown, current: TranscriptTurn, history: readonly TranscriptTurn[], schema: Record<string, unknown>): PreparedCallsignExtraction | undefined {
  const validate = shapeValidator(schema)
  if (!validate || validate(value))
    return undefined
  const raw = value as CallsignExtraction
  const hadSelf = raw.selfCallsigns.length > 0
  const extraction = cleanEvidence(deriveStandardSpelling(current, history, raw), current)
  const sources = new Map([...history, current].map(turn => [turn.id, turn]))
  const spellings: Candidate[] = extraction.spelledCallsigns.flatMap((entry) => {
    const evidence = spans(sources.get(entry.sourceId), entry.quote)
    return entry.callsign && evidence.length
      ? [{ callsign: entry.callsign, confidence: entry.confidence, kind: 'spelling' as const, spans: evidence }]
      : []
  })
  const selves = extraction.selfCallsigns.flatMap((entry) => {
    const candidate = selfCandidate(entry, current, extraction.spelledCallsigns)
    return candidate ? [candidate] : []
  })
  return {
    extraction,
    hadSelf,
    input: {
      eligible: /[b布补]/i.test(current.text) || /[b布补]/i.test(correctExplanationText(current.text).text),
      hadSelf,
      selves,
      spellings,
      features: [],
      signals: [],
    },
  }
}

export function resolveCallsign(prepared: PreparedCallsignExtraction, matches: readonly Pick<SpeakerMatch, 'callsign' | 'confidence'>[] = [], signals: readonly RadioSignal[] = []): CallsignResolution {
  const features: Candidate[] = matches.flatMap(item => item.confidence
    ? [{ callsign: item.callsign, confidence: item.confidence, kind: 'feature' as const, spans: [] }]
    : [])
  const decision = decide({ ...prepared.input, features, signals: [...signals] })
  if (!decision.callsign)
    return { decision }
  return { callsign: decision.callsign, algorithm: decision.selfOrigin === 'self' ? 'stage1_text' : 'stage2_feature', decision }
}
