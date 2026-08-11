// Unified per-segment record accumulating every pipeline stage:
// segmentation fills the audio fields, ASR fills recognition and corrected,
// the LLM stage fills revise/callsign/risk. Optional fields stay absent while the
// corresponding stage has not run or failed.
export interface SegmentRecord {
  id: string
  timestamp: string
  durationMs: number
  payloads: Uint8Array[]
  voicedMs: number
  recognition?: string | undefined
  corrected?: string | undefined
  revise?: string | undefined
  callsign?: string | undefined
  risk?: RiskRating | undefined
}

export interface RiskRating {
  level: number
  reason: string
}

const MAX_RECORDS = 500
// DashScope context enhancement truncates silently beyond 400 chars per turn.
export const ASR_CONTEXT_BUDGET = 380
// Chat models handle longer prompts; keep the history readable but bounded.
export const LLM_HISTORY_BUDGET = 2_000

// Rolling per-node window of segment records, and the single source for both
// the ASR context (raw recognitions) and the LLM history (revised messages).
export class SegmentStore {
  private entries: Array<{ at: number, record: SegmentRecord }> = []

  constructor(
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  add(record: SegmentRecord): void {
    this.entries.push({ at: this.now(), record })
    if (this.entries.length > MAX_RECORDS)
      this.entries.splice(0, this.entries.length - MAX_RECORDS)
  }

  recent(): SegmentRecord[] {
    this.prune()
    return this.entries.map(entry => entry.record)
  }

  // Chronological raw recognition texts for the ASR context turn.
  asrContext(budget: number = ASR_CONTEXT_BUDGET): string | undefined {
    const texts: string[] = []
    for (const record of this.recent()) {
      if (record.recognition !== undefined)
        texts.push(record.recognition)
    }
    return joinWithinBudget(texts, budget)
  }

  // Revised messages (falling back to the raw recognition) for the LLM
  // history block. The segment being parsed is excluded so its text appears
  // only as the "current" turn.
  llmHistory(budget: number = LLM_HISTORY_BUDGET, excludeId?: string): string | undefined {
    const lines: string[] = []
    for (const record of this.recent()) {
      if (excludeId !== undefined && record.id === excludeId)
        continue
      const text = record.revise ?? record.recognition
      if (text === undefined)
        continue
      const risk = record.risk
      // Do not feed model-generated callsign labels back as evidence. The raw
      // or revised transcript may still contain genuine phonetic spelling.
      lines.push(`${risk && risk.level > 1 ? `[风控${risk.level}] ` : ''}${text}`)
    }
    return joinWithinBudget(lines, budget)
  }

  private prune(): void {
    const cutoff = this.now() - this.windowMs
    while (this.entries.length > 0) {
      const oldest = this.entries[0]
      if (!oldest || oldest.at >= cutoff)
        break
      this.entries.shift()
    }
  }
}

// Chronological join trimmed to the budget, dropping the oldest entries first.
function joinWithinBudget(texts: string[], budget: number): string | undefined {
  if (texts.length === 0)
    return undefined
  while (texts.length > 1 && texts.join('\n').length > budget)
    texts.shift()
  const joined = texts.join('\n')
  if (joined.length <= budget)
    return joined
  return joined.slice(-budget)
}
