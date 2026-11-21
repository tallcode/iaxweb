export interface RiskRating {
  level: number
  reason: string
}

export interface TranscriptAnalysis {
  message?: string | undefined
  risk?: RiskRating | undefined
}

// Shared extraction contract for all model prompts. Matching is computed by
// the backend and is deliberately absent from model output.
export interface CallsignExtraction {
  selfCallsignEvidence: string | null
  spelledCallsignEvidence: Array<{ quote: string, callsign: string }>
  selfCallsign: string | null
  spelledCallsigns: string[]
}

export interface CallsignModelOutput extends CallsignExtraction, TranscriptAnalysis {}
