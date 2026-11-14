import type { PhoneticCorrection } from './phonetic-corrector.js'
import { extractCallsignEvidence } from './callsign-evidence.js'
import { correctExplanationWord } from './phonetic-corrector.js'
import { spellingGate, tokenize } from './phonetic-near-context.js'
import { nearSpellingCorrections } from './phonetic-near.js'

export interface TranscriptCorrection {
  source: string
  replacement: string
  canonical: string
  start: number
  end: number
  method: PhoneticCorrection['method'] | 'ipa-near'
  distance: number
}

function display(word: string): string {
  return word === 'x-ray' ? 'X-ray' : word[0]!.toUpperCase() + word.slice(1)
}

// Generates only auxiliary corrected text. It does not add callsign evidence,
// change the ASR original, decide ownership, or issue any model requests.
export function correctExplanationText(input: string): { text: string, corrections: TranscriptCorrection[] } {
  const tokens = tokenize(input)
  const near = nearSpellingCorrections(input).slice(0, 1)
  // Near matches can help delimit exact-word normalization, but may not act as
  // strong anchors for another uncertain match (matching ran on raw text).
  const contextual = tokens.map((token) => {
    const correction = near.find(row => row.start === token.start)
    return correction ? { ...token, symbol: correctExplanationWord(correction.replacement)!.symbol } : token
  })
  const evidence = extractCallsignEvidence({ id: 'corrected-only', text: input })
  const corrections: TranscriptCorrection[] = []
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    if (token.kind !== 'word')
      continue
    const found = correctExplanationWord(token.source)
    if (!found || (found.method === 'exact' && found.language === 'en'))
      continue
    let inContext = evidence.some(item => item.start <= token.start && item.end >= token.end)
      || spellingGate(input, contextual, index).allowed
    // Preserve validated leading Bravo aliases in incomplete spelling too.
    // Compact text is merely a context cue, never new callsign evidence.
    if (!inContext && found.method === 'alias' && found.symbol === 'B') {
      const following = contextual.slice(index + 1)
      const first = following[0]
      const second = following[1]
      const prefix = first?.symbol && /^[ADGHIY]$/.test(first.symbol) && second?.kind === 'digit'
      const compact = /\bB[ADGHIY]\d[A-Z]{2,3}\b/i.test(input.slice(Math.max(0, token.start - 32), token.start))
      const adjacent = first && /^[\s,，、:：-]*$/u.test(input.slice(token.end, first.start))
      inContext = !!(adjacent && (prefix || (compact && first.strong)))
    }
    if (!inContext)
      continue
    const replacement = display(found.canonical)
    if (replacement !== token.source)
      corrections.push({ source: token.source, replacement, canonical: found.canonical, start: token.start, end: token.end, method: found.method, distance: found.distance })
  }
  for (const correction of near)
    corrections.push({ ...correction, canonical: correction.replacement, replacement: display(correction.replacement) })
  let text = input
  for (const correction of [...corrections].sort((a, b) => b.start - a.start))
    text = text.slice(0, correction.start) + correction.replacement + text.slice(correction.end)
  return { text, corrections: corrections.sort((a, b) => a.start - b.start) }
}
