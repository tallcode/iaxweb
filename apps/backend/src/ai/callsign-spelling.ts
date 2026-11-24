import type { TranscriptTurn } from './callsign-evidence.js'
import type { CallsignExtraction } from './callsign-extraction.js'
import { CALLSIGN_PATTERN } from '@iaxweb/contracts'
import { CALLSIGN_VOCABULARY } from './callsign-vocabulary.js'

const words = Object.keys(CALLSIGN_VOCABULARY).sort((a, b) => b.length - a.length)

// A finite dictionary joins complete standard words. It never guesses a sound
// or repairs letters in a compact callsign.
export function standardCharacters(text: string): string | null {
  const normalized = text.normalize('NFKC').toUpperCase().replace(/[\s,，.。;；:：、!?！？“”"'’-]/g, '')
  const memo = new Map<number, string | null>()
  function decode(at: number): string | null {
    if (at === normalized.length)
      return ''
    if (memo.has(at))
      return memo.get(at)!
    for (const word of words) {
      if (!normalized.startsWith(word, at))
        continue
      const rest = decode(at + word.length)
      if (rest !== null) {
        const result = CALLSIGN_VOCABULARY[word]! + rest
        memo.set(at, result)
        return result
      }
    }
    memo.set(at, null)
    return null
  }
  return decode(0)
}

function sourceCharacters(quote: string): string | null {
  const literal = standardCharacters(quote)
  if (literal !== null)
    return literal
  const normalized = quote.replace(/(\b(?:zero|one|two|three|four|five|six|seven|eight|nine)|[\d零一二三四五六七八九洞幺两拐勾])\s*瓦/gi, '$1')
  return standardCharacters(normalized)
}

export function validSpelling(entry: CallsignExtraction['spelledCallsigns'][number]): boolean {
  if (entry.callsign === null)
    return entry.confidence === 'low'
  if (!CALLSIGN_PATTERN.test(entry.callsign))
    return false
  const decoded = standardCharacters(entry.correctedSpelling)
  const original = standardCharacters(entry.quote)
  return decoded === entry.callsign && (original === null || original === entry.callsign)
}

// Requires a structurally validated extraction. Only the character view changes:
// ownership, evidence spans, compact reports and confidence remain untouched.
export function deriveStandardSpelling(current: TranscriptTurn, history: readonly TranscriptTurn[], raw: CallsignExtraction): CallsignExtraction {
  const sources = new Map([...history, current].map(turn => [turn.id, turn.text]))
  const replacements = new Map<number, string>()
  const spelling = raw.spelledCallsigns.map((entry, index) => {
    if (entry.callsign === null && entry.confidence !== 'low')
      return entry
    const text = sources.get(entry.sourceId)
    if (!entry.quote || !text?.includes(entry.quote))
      return entry
    const canonical = standardCharacters(entry.correctedSpelling)
    if (!canonical || !CALLSIGN_PATTERN.test(canonical) || sourceCharacters(entry.quote) !== canonical || canonical === entry.callsign)
      return entry
    // A shorter quote may omit the final word. Never shorten an existing call.
    if (entry.callsign !== null && entry.callsign.length !== canonical.length)
      return entry
    replacements.set(index, canonical)
    return { ...entry, callsign: canonical }
  })
  const verifiedViews = spelling.filter(validSpelling)
  const selves = raw.selfCallsigns.map((entry) => {
    if (entry.type !== 'spelling')
      return entry
    const linked = raw.spelledCallsigns.map((item, n) => ({ item, n })).filter(({ item }) => item.sourceId === current.id
      && item.quote === entry.quote && item.callsign === entry.callsign && item.confidence === entry.confidence)
    const direct = [...new Set(linked.map(({ n }) => replacements.get(n)).filter((call): call is string => Boolean(call)))]
    const views = verifiedViews.filter(item => item.sourceId === current.id && item.quote === entry.quote
      && item.confidence === entry.confidence && item.callsign && current.text.includes(item.quote)
      && standardCharacters(item.correctedSpelling) === item.callsign && sourceCharacters(item.quote) === item.callsign)
    const agreed = [...new Set(views.map(item => item.callsign!))]
    const replacement = direct.length === 1 ? direct[0] : agreed.length === 1 ? agreed[0] : undefined
    if (!replacement || replacement === entry.callsign
      || (entry.callsign === null && entry.confidence !== 'low')
      || (entry.callsign !== null && entry.callsign.length !== replacement.length)) {
      return entry
    }
    return { ...entry, callsign: replacement }
  })
  return { selfCallsigns: selves, spelledCallsigns: spelling }
}
