import type { TranscriptTurn } from './callsign-evidence.js'
import { isValidCallsign } from '@iaxweb/contracts'

// The model extracts evidence. Callsign matching is computed by the backend.
export interface CallsignExtraction {
  selfCallsignEvidence: string | null
  spelledCallsignEvidence: Array<{ quote: string, callsign: string }>
  selfCallsign: string | null
  spelledCallsigns: string[]
}

// Keep the model's identity decision intact. Only discard malformed, unsupported
// or duplicate spelling entries; never decode words or infer speaker roles here.
export function cleanCallsignExtraction(value: Record<string, unknown>, current: string, history: readonly TranscriptTurn[]): CallsignExtraction | undefined {
  const { selfCallsign, selfCallsignEvidence, spelledCallsignEvidence, spelledCallsigns, ...extra } = value
  if (Object.keys(extra).length > 0
    || (selfCallsign !== null && (typeof selfCallsign !== 'string' || !/^[A-Z0-9]{2,8}$/.test(selfCallsign)))
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
  return { selfCallsignEvidence, spelledCallsignEvidence: evidence, selfCallsign, spelledCallsigns: evidence.map(item => item.callsign) }
}

export function matchExtractedCallsign(extraction: CallsignExtraction): string | undefined {
  const self = extraction.selfCallsign
  if (!self || !extraction.selfCallsignEvidence?.trim())
    return undefined
  const matching = [...new Set(extraction.spelledCallsigns)]
    .filter(call => call === self || call.slice(2) === self || call.slice(3) === self)
  return matching.length === 1 ? matching[0] : undefined
}
