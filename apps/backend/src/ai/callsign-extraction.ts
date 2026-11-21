import type { TranscriptTurn } from './callsign-evidence.js'
import type { CallsignExtraction } from './callsign-model-output.js'
import { isValidCallsign } from '@iaxweb/contracts'

export type { CallsignExtraction } from './callsign-model-output.js'

// Keep the model's identity decision intact. Only discard malformed, unsupported
// or duplicate spelling entries; never decode words or infer speaker roles here.
export function cleanCallsignExtraction(value: Record<string, unknown>, current: string, history: readonly TranscriptTurn[]): Record<string, unknown> | undefined {
  const { selfCallsign, selfCallsignEvidence, spelledCallsignEvidence, spelledCallsigns } = value
  if ((selfCallsign !== null && (typeof selfCallsign !== 'string' || !/^[A-Z0-9]{2,8}$/.test(selfCallsign)))
    || (selfCallsignEvidence !== null && (typeof selfCallsignEvidence !== 'string' || !selfCallsignEvidence.trim() || !current.includes(selfCallsignEvidence)))
    || (selfCallsign === null) !== (selfCallsignEvidence === null)
    || !Array.isArray(spelledCallsignEvidence) || !Array.isArray(spelledCallsigns)
    || !spelledCallsigns.every(call => typeof call === 'string')) {
    return undefined
  }
  const declared = new Set(spelledCallsigns)
  const seen = new Set<string>()
  const texts = [current, ...history.map(turn => turn.text)]
  const evidence: CallsignExtraction['spelledCallsignEvidence'] = []
  for (const item of spelledCallsignEvidence) {
    if (!item || typeof item !== 'object' || typeof item.quote !== 'string' || !item.quote.trim()
      || typeof item.callsign !== 'string' || !isValidCallsign(item.callsign)
      || !texts.some(text => text.includes(item.quote)) || !declared.has(item.callsign) || seen.has(item.callsign)) {
      continue
    }
    seen.add(item.callsign)
    evidence.push({ quote: item.quote, callsign: item.callsign })
  }
  return { ...value, selfCallsignEvidence, spelledCallsignEvidence: evidence, selfCallsign, spelledCallsigns: evidence.map(item => item.callsign) }
}

export function readCallsignExtraction(value: Record<string, unknown>): CallsignExtraction {
  // Called after structural checks and the configured schema validation.
  return {
    selfCallsignEvidence: value.selfCallsignEvidence as string | null,
    spelledCallsignEvidence: value.spelledCallsignEvidence as CallsignExtraction['spelledCallsignEvidence'],
    selfCallsign: value.selfCallsign as string | null,
    spelledCallsigns: value.spelledCallsigns as string[],
  }
}

export function matchExtractedCallsign(extraction: CallsignExtraction): string | undefined {
  const self = extraction.selfCallsign
  if (!self || !extraction.selfCallsignEvidence?.trim())
    return undefined
  const matching = [...new Set(extraction.spelledCallsigns)]
    .filter(call => call === self || call.slice(2) === self || call.slice(3) === self)
  return matching.length === 1 ? matching[0] : undefined
}
