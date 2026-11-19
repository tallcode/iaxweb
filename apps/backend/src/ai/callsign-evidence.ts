import { CALLSIGN_PATTERN } from '@iaxweb/contracts'
import { CHINESE_EXPLANATION_WORDS, correctExplanationWord, pinyinSyllables } from './phonetic-corrector.js'

export interface TranscriptTurn {
  id: string
  text: string
  transmissionId?: string | undefined
  partIndex?: number | undefined
}

interface ExplanationToken {
  source: string
  symbol?: string | undefined
  method?: string | undefined
  start: number
  end: number
}

export interface CallsignEvidence {
  id: number
  segmentId: string
  callsign: string
  kind: 'full' | 'suffix' | 'prefix-and-suffix' | 'repeated-prefix-letter' | 'verified-continuation'
  quote: string
  start: number
  end: number
  prefixQuote?: string
  segmentIds?: string[]
}

export interface CallsignContext {
  current: TranscriptTurn
  history: readonly TranscriptTurn[]
  candidates: CallsignEvidence[]
}

const DIGITS: Record<string, string> = {
  zero: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  幺: '1',
  两: '2',
  拐: '7',
  洞: '0',
  勾: '9',
  零: '0',
  一: '1',
  二: '2',
  三: '3',
  四: '4',
  五: '5',
  六: '6',
  七: '7',
  八: '8',
  九: '9',
}
const CALLSIGN = CALLSIGN_PATTERN
const CHINESE_SPELLINGS = CHINESE_EXPLANATION_WORDS
  .map(word => pinyinSyllables(word.spoken))
  .sort((left, right) => right.length - left.length)

// Tokenize raw ASR evidence without treating directly spoken letters as
// explanation words. Matching uses the existing correction vocabulary only.
function explanationTokens(text: string): ExplanationToken[] {
  const tokens: ExplanationToken[] = []
  for (const match of text.matchAll(/\bX[ \t-]+Ray\b|[A-Z]+(?:-[A-Z]+)?|\d|\p{Script=Han}+/giu)) {
    const source = match[0]
    const start = match.index
    if (/^\p{Script=Han}+$/u.test(source)) {
      const characters = [...source]
      const syllables = pinyinSyllables(source)
      let offset = 0
      for (let index = 0; index < characters.length;) {
        const character = characters[index]!
        const digit = DIGITS[character]
        if (digit) {
          tokens.push({ source: character, symbol: digit, method: 'digit', start: start + offset, end: start + offset + character.length })
          offset += character.length
          index++
          continue
        }
        let token: ExplanationToken | undefined
        // Check the fixed vocabulary before invoking the cached corrector;
        // ordinary prose must not fill its cache with every possible n-gram.
        const spelling = syllables.length === characters.length
          ? CHINESE_SPELLINGS.find(candidate => candidate.every((syllable, position) => syllables[index + position] === syllable))
          : undefined
        if (spelling) {
          const word = characters.slice(index, index + spelling.length).join('')
          const correction = correctExplanationWord(word)
          if (correction)
            token = { source: word, symbol: correction.symbol, method: correction.method, start: start + offset, end: start + offset + word.length }
        }
        tokens.push(token ?? { source: character, start: start + offset, end: start + offset + character.length })
        offset += token?.source.length ?? character.length
        index += token ? [...token.source].length : 1
      }
      continue
    }
    const digit = DIGITS[source.toLowerCase()] ?? (/^\d$/.test(source) ? source : undefined)
    const correction = !digit && source.length > 1
      ? correctExplanationWord(/^x[ \t-]+ray$/i.test(source) ? 'x-ray' : source)
      : undefined
    tokens.push({ source, symbol: digit ?? correction?.symbol, method: digit ? 'digit' : correction?.method, start, end: start + source.length })
  }
  return tokens
}

export function extractCallsignEvidence(turn: TranscriptTurn): CallsignEvidence[] {
  const { text } = turn
  const evidence: CallsignEvidence[] = []
  let run: ExplanationToken[] = []
  let pendingPrefix: { prefix: string, start: number, end: number } | undefined
  const add = (part: ExplanationToken[], callsign: string, kind: CallsignEvidence['kind'], prefixQuote?: string): void => {
    const start = part[0]!.start
    const end = part.at(-1)!.end
    evidence.push({ id: 0, segmentId: turn.id, callsign, kind, quote: text.slice(start, end), start, end, ...(prefixQuote ? { prefixQuote } : {}) })
  }
  const flush = (): void => {
    for (const size of [5, 6]) {
      for (let index = 0; index + size <= run.length; index++) {
        const part = run.slice(index, index + size)
        const callsign = part.map(token => token.symbol).join('')
        const tail = run.slice(index + size).map(token => token.symbol).join('')
        if (CALLSIGN.test(callsign) && (!tail || /^B[ADGHIY]\d/.test(tail)))
          add(part, callsign, 'full')
      }
    }
    // The extra repeated prefix letter is distinguishable from meaningful
    // repeated suffix letters; never collapse arbitrary suffix repetitions.
    for (let index = 0; index + 7 <= run.length; index++) {
      const part = run.slice(index, index + 7)
      const spelled = part.map(token => token.symbol).join('')
      const tail = run.slice(index + 7).map(token => token.symbol).join('')
      if (/^B([ADGHIY])\1\d[A-Z]{3}$/.test(spelled) && (!tail || /^B[ADGHIY]\d/.test(tail)))
        add(part, spelled.slice(0, 2) + spelled.slice(3), 'repeated-prefix-letter')
    }
    const spelled = run.map(token => token.symbol).join('')
    if (/^B[ADGHIY]\d$/.test(spelled))
      pendingPrefix = { prefix: spelled, start: run[0]!.start, end: run.at(-1)!.end }
    if (/^[A-Z]{2,3}$/.test(spelled)) {
      const start = run[0]!.start
      const compact = [...text.slice(0, start).matchAll(/\b(B[ADGHIY]\d)[A-Z]{0,3}\b/gi)].at(-1)
      const gap = compact ? text.slice(compact.index + compact[0].length, start) : ''
      if (compact && /^[\s，,。.:：;；-]*(?:(?:尾号|后缀|字母解释法|拼读)(?:是|为)?[\s，,。.:：;；-]*)?$/.test(gap))
        add(run, compact[1]!.toUpperCase() + spelled, 'suffix', compact[0])
      else if (pendingPrefix && start - pendingPrefix.end <= 8 && /^[\s，,。.:：瓦]*$/.test(text.slice(pendingPrefix.end, start)))
        add(run, pendingPrefix.prefix + spelled, 'prefix-and-suffix', text.slice(pendingPrefix.start, pendingPrefix.end))
    }
    run = []
  }
  for (const token of explanationTokens(text)) {
    if (token.symbol)
      run.push(token)
    else
      flush()
  }
  flush()
  return evidence.filter((item, index) => evidence.findIndex(other => other.callsign === item.callsign && other.start === item.start && other.end === item.end) === index)
}

export function buildCallsignContext(current: TranscriptTurn, history: readonly TranscriptTurn[] = []): CallsignContext {
  const candidates = [...history, current].flatMap(extractCallsignEvidence)
  const previous = history.at(-1)
  if (previous?.transmissionId && previous.transmissionId === current.transmissionId
    && previous.partIndex !== undefined && current.partIndex === previous.partIndex + 1) {
    const joined = `${previous.text}\n${current.text}`
    for (const item of extractCallsignEvidence({ id: current.id, text: joined })) {
      if (item.start < previous.text.length && item.end > previous.text.length + 1)
        candidates.push({ ...item, kind: 'verified-continuation', segmentIds: [previous.id, current.id] })
    }
  }
  return { current, history, candidates: candidates.map((candidate, index) => ({ ...candidate, id: index + 1 })) }
}

// Stage 2 only. Require adjacent, delimited prefix and suffix phrases after
// the compact self-call. The prefix's B and district digit must both agree
// before borrowing its middle letter for an unrecognized Han syllable.
export function recoverSelfSpelling(current: TranscriptTurn, compact: string, selfEnd: number, id: number): CallsignEvidence | undefined {
  const parts = /^[ \t]*[，,]([^，,。！？；.!?;\r\n]+)[，,]([^，,。！？；.!?;\r\n]+)/u.exec(current.text.slice(selfEnd))
  if (!parts)
    return undefined
  const prefixPhrase = parts[1]!.trim()
  const suffixPhrase = parts[2]!.trim()
  const prefix = explanationTokens(prefixPhrase)
  const suffix = explanationTokens(suffixPhrase)
  if (prefix.length !== 3 || suffix.length < 2 || suffix.length > 3
    || prefix.map(token => token.source).join('').replaceAll(/\s/gu, '') !== prefixPhrase.replaceAll(/\s/gu, '')
    || suffix.map(token => token.source).join('').replaceAll(/\s/gu, '') !== suffixPhrase.replaceAll(/\s/gu, '')) {
    return undefined
  }
  const [first, middle, digit] = prefix as [ExplanationToken, ExplanationToken, ExplanationToken]
  if (first.symbol !== compact[0] || digit.symbol !== compact[2]
    || (middle.symbol ? middle.symbol !== compact[1] : !/^\p{Script=Han}$/u.test(middle.source))
    || suffix.some(token => !token.symbol)) {
    return undefined
  }
  const callsign = compact.slice(0, 3) + suffix.map(token => token.symbol).join('')
  if (!CALLSIGN.test(callsign))
    return undefined
  const start = selfEnd + parts[0].trimEnd().length - suffixPhrase.length
  return {
    id,
    segmentId: current.id,
    kind: 'suffix',
    callsign,
    prefixQuote: current.text.slice(selfEnd - compact.length, selfEnd),
    quote: suffixPhrase,
    start,
    end: start + suffixPhrase.length,
  }
}
