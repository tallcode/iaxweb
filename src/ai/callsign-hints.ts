import { readFileSync } from 'node:fs'
import { isValidCallsign } from './spot-store.js'

export interface CallsignHintCandidate {
  callsign: string
  distance: number
  score: number
}

export interface CallsignHintGroup {
  candidates: CallsignHintCandidate[]
  source: string
}

const DIGIT_WORDS: Record<string, string> = {
  eight: '8',
  five: '5',
  four: '4',
  nine: '9',
  one: '1',
  seven: '7',
  six: '6',
  three: '3',
  two: '2',
  zero: '0',
}

// NATO plus the alternate words already used by this project's hotword list.
const LETTER_WORDS: Record<string, string> = {
  'alpha': 'A',
  'american': 'A',
  'boston': 'B',
  'bravo': 'B',
  'canada': 'C',
  'charlie': 'C',
  'delta': 'D',
  'denmark': 'D',
  'echo': 'E',
  'england': 'E',
  'florida': 'F',
  'foxtrot': 'F',
  'germany': 'G',
  'golf': 'G',
  'hotel': 'H',
  'honolulu': 'H',
  'india': 'I',
  'italy': 'I',
  'japan': 'J',
  'juliet': 'J',
  'kentucky': 'K',
  'kilo': 'K',
  'lima': 'L',
  'london': 'L',
  'mexico': 'M',
  'mike': 'M',
  'norway': 'N',
  'november': 'N',
  'ontario': 'O',
  'oscar': 'O',
  'papa': 'P',
  'paris': 'P',
  'quebec': 'Q',
  'romeo': 'R',
  'rome': 'R',
  'santiago': 'S',
  'sierra': 'S',
  'tango': 'T',
  'tokyo': 'T',
  'uniform': 'U',
  'united': 'U',
  'victor': 'V',
  'victoria': 'V',
  'washington': 'W',
  'whiskey': 'W',
  'x-ray': 'X',
  'xray': 'X',
  'yankee': 'Y',
  'yokohama': 'Y',
  'zanzibar': 'Z',
  'zulu': 'Z',
}

const CHINESE_DIGITS: Record<string, string> = {
  两: '2',
  一: '1',
  七: '7',
  三: '3',
  九: '9',
  二: '2',
  五: '5',
  八: '8',
  六: '6',
  勾: '9',
  四: '4',
  幺: '1',
  拐: '7',
  洞: '0',
  零: '0',
}

export class CallsignHintMatcher {
  private lastGoodCallsigns: string[] = []

  constructor(private readonly callsignsPath: string) {}

  match(transcript: string): CallsignHintGroup[] {
    const callsigns = this.loadCallsigns()
    if (callsigns.length === 0)
      return []

    const fragments = extractCallsignFragments(transcript)
    const groups: CallsignHintGroup[] = []
    for (const fragment of fragments) {
      const candidates = rankCandidates(fragment.normalized, callsigns)
      if (candidates.length > 0)
        groups.push({ candidates, source: fragment.source })
    }
    return groups.sort((left, right) => left.candidates[0]!.distance - right.candidates[0]!.distance)
  }

  private loadCallsigns(): string[] {
    let text: string
    try {
      text = readFileSync(this.callsignsPath, 'utf8')
    }
    catch {
      return this.lastGoodCallsigns
    }

    const callsigns = new Set<string>()
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.replace(/#.*$/, '').trim().toUpperCase()
      if (line && isValidCallsign(line))
        callsigns.add(line)
    }
    this.lastGoodCallsigns = [...callsigns]
    return this.lastGoodCallsigns
  }
}

interface CallsignFragment {
  normalized: string
  source: string
}

export function extractCallsignFragments(transcript: string): CallsignFragment[] {
  const fragments = new Map<string, CallsignFragment>()

  // Compact forms such as BG5FVT. Long contiguous runs can contain multiple
  // callsigns without a separator, so apply the same 5–8 character sliding
  // window used for phonetic tokens. Chinese digit forms such as BG两GJJ are
  // normalized before comparison.
  for (const match of transcript.matchAll(/(?<![A-Z0-9幺两拐洞勾零一二三四五六七八九])[A-Z0-9幺两拐洞勾零一二三四五六七八九]{5,}(?![A-Z0-9幺两拐洞勾零一二三四五六七八九])/giu)) {
    const run = [...match[0]!]
    const lengths = run.length <= 8 ? [run.length] : [8, 7, 6, 5]
    for (const length of lengths) {
      for (let start = 0; start + length <= run.length; start++) {
        const source = run.slice(start, start + length).join('')
        const normalized = [...source]
          .map(character => CHINESE_DIGITS[character] ?? character.toUpperCase())
          .join('')
        if (isCallsignLike(normalized))
          fragments.set(normalized, { normalized, source })
      }
    }
  }

  // Convert consecutive phonetic/digit tokens into character sequences. This
  // also handles spaced compact forms such as "B G 两 G J J".
  const tokens = transcript.match(/[A-Za-z]+(?:-[A-Za-z]+)?|[0-9幺两拐洞勾零一二三四五六七八九，,。；;:：]|\p{Script=Han}+/gu) ?? []
  let run: Array<{ normalized: string, source: string }> = []
  const flush = (): void => {
    const lengths = run.length <= 8 ? [run.length] : [8, 7, 6, 5]
    for (const length of lengths) {
      for (let start = 0; start + length <= run.length; start++) {
        const window = run.slice(start, start + length)
        const normalized = window.map(token => token.normalized).join('')
        const source = window.map(token => token.source).join(' ')
        if (isCallsignLike(normalized))
          fragments.set(normalized, { normalized, source })
      }
    }
    run = []
  }

  for (const token of tokens) {
    const normalized = normalizeToken(token)
    if (!normalized) {
      flush()
      continue
    }
    run.push({ normalized, source: token })
  }
  flush()

  return [...fragments.values()]
}

function normalizeToken(token: string): string | undefined {
  if (/^[A-Z]$/i.test(token))
    return token.toUpperCase()
  if (/^\d$/.test(token))
    return token
  const chineseDigit = CHINESE_DIGITS[token]
  if (chineseDigit)
    return chineseDigit
  const lower = token.toLowerCase()
  return LETTER_WORDS[lower] ?? DIGIT_WORDS[lower]
}

function isCallsignLike(value: string): boolean {
  if (!/^[A-Z0-9]{5,8}$/.test(value) || !/\d/.test(value))
    return false
  return value.startsWith('B')
    || /^[A-Z][ADGHIY]\d/.test(value)
    || /^[A-Z]\d[A-Z0-9]{3,6}$/.test(value)
}

function rankCandidates(fragment: string, callsigns: string[]): CallsignHintCandidate[] {
  return callsigns
    .map((callsign) => {
      const distance = levenshteinDistance(fragment, callsign)
      return {
        callsign,
        distance,
        score: Number((1 - distance / callsign.length).toFixed(3)),
      }
    })
    .filter((candidate) => {
      // Callsigns are spoken in sequence. For equal-length strings permit
      // only one positional substitution. This rejects reordered suffixes
      // such as FVT -> FTV.
      if (fragment.length === candidate.callsign.length)
        return positionalMismatchCount(fragment, candidate.callsign) <= 1

      // ASR can insert or omit a character; retain that tolerance only when
      // the lengths differ. Ordinary Levenshtein deliberately gives no
      // discounted cost to a transposition.
      return candidate.distance <= 2
    })
    .sort((left, right) => left.distance - right.distance || left.callsign.localeCompare(right.callsign))
}

function positionalMismatchCount(left: string, right: string): number {
  let mismatches = 0
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index])
      mismatches++
  }
  return mismatches
}

export function levenshteinDistance(left: string, right: string): number {
  const rows = left.length + 1
  const columns = right.length + 1
  const matrix = Array.from({ length: rows }, () => Array.from({ length: columns }).fill(0) as number[])

  for (let row = 0; row < rows; row++)
    matrix[row]![0] = row
  for (let column = 0; column < columns; column++)
    matrix[0]![column] = column

  for (let row = 1; row < rows; row++) {
    for (let column = 1; column < columns; column++) {
      const substitutionCost = left[row - 1] === right[column - 1] ? 0 : 1
      matrix[row]![column] = Math.min(
        matrix[row - 1]![column]! + 1,
        matrix[row]![column - 1]! + 1,
        matrix[row - 1]![column - 1]! + substitutionCost,
      )
    }
  }

  return matrix[left.length]![right.length]!
}

export function formatCallsignHints(groups: CallsignHintGroup[]): string | undefined {
  const candidatesByCallsign = new Map<string, { candidate: CallsignHintCandidate, source: string }>()
  for (const group of groups) {
    for (const candidate of group.candidates) {
      const previous = candidatesByCallsign.get(candidate.callsign)
      if (!previous || candidate.distance < previous.candidate.distance
        || (candidate.distance === previous.candidate.distance && candidate.score > previous.candidate.score)) {
        candidatesByCallsign.set(candidate.callsign, { candidate, source: group.source })
      }
    }
  }

  const merged = [...candidatesByCallsign.values()]
  const minimumDistance = Math.min(...merged.map(item => item.candidate.distance))
  if (!Number.isFinite(minimumDistance) || minimumDistance > 1)
    return undefined

  const lines = merged
    .filter(item => item.candidate.distance === minimumDistance)
    .sort((left, right) => left.candidate.callsign.localeCompare(right.candidate.callsign))
    .map(item => `- 原文片段“${item.source}”：${item.candidate.callsign}（距离 ${item.candidate.distance}）`)
  return `常见呼号相似度候选：\n${lines.join('\n')}`
}
