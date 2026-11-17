import type { CallsignContext, CallsignEvidence } from './callsign-evidence.js'

// Full IDs and semantic evidence stay intact. Media segmentation and character
// offsets are only needed by the local validator, not by the text model.
export function callsignPayload(
  context: CallsignContext,
  candidates: readonly (CallsignEvidence & { suggestedQuote?: string })[] = context.candidates,
) {
  return {
    history: context.history.map(turn => ({ id: turn.id, text: turn.text })),
    current: { id: context.current.id, text: context.current.text },
    candidates: candidates.map(candidate => ({
      id: candidate.id,
      segmentId: candidate.segmentId,
      callsign: candidate.callsign,
      kind: candidate.kind,
      quote: candidate.quote,
      ...(candidate.prefixQuote !== undefined ? { prefixQuote: candidate.prefixQuote } : {}),
      ...(candidate.segmentIds !== undefined ? { segmentIds: candidate.segmentIds } : {}),
      ...(candidate.suggestedQuote !== undefined ? { suggestedQuote: candidate.suggestedQuote } : {}),
    })),
  }
}
