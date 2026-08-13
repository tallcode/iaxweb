import cmudict from '@lunarisapp/cmudict'
import { distance } from 'fastest-levenshtein'
import { pinyin } from 'pinyin-pro'

export interface PhoneticCorrection {
  canonical: string
  distance: number
  language: 'en' | 'zh'
  matched: string
  method: 'alias' | 'cmudict' | 'cmudict-window' | 'exact' | 'pinyin'
  symbol: string
}

export interface CorrectedExplanationText {
  corrections: Array<PhoneticCorrection & { source: string }>
  text: string
}

interface ExplanationWord {
  canonical: string
  symbol: string
  word: string
}

const NATO_WORDS: Record<string, string> = {
  'alpha': 'A',
  'bravo': 'B',
  'charlie': 'C',
  'delta': 'D',
  'echo': 'E',
  'foxtrot': 'F',
  'golf': 'G',
  'hotel': 'H',
  'india': 'I',
  'juliet': 'J',
  'kilo': 'K',
  'lima': 'L',
  'mike': 'M',
  'november': 'N',
  'oscar': 'O',
  'papa': 'P',
  'quebec': 'Q',
  'romeo': 'R',
  'sierra': 'S',
  'tango': 'T',
  'uniform': 'U',
  'victor': 'V',
  'whiskey': 'W',
  'x-ray': 'X',
  'yankee': 'Y',
  'zulu': 'Z',
}

// Alternate explanation words already accepted by the project's hotword set.
const ALTERNATE_WORDS: Record<string, string> = {
  american: 'A',
  america: 'A',
  boston: 'B',
  canada: 'C',
  denmark: 'D',
  england: 'E',
  florida: 'F',
  fox: 'F',
  germany: 'G',
  honolulu: 'H',
  italy: 'I',
  japan: 'J',
  kentucky: 'K',
  london: 'L',
  mexico: 'M',
  norway: 'N',
  ontario: 'O',
  ocean: 'O',
  paris: 'P',
  queen: 'Q',
  rome: 'R',
  santiago: 'S',
  sugar: 'S',
  tokyo: 'T',
  united: 'U',
  victoria: 'V',
  washington: 'W',
  xray: 'X',
  yokohama: 'Y',
  zanzibar: 'Z',
}

// These are ASR-model errors rather than genuine pronunciation neighbours.
const ENGLISH_ASR_ALIASES: Record<string, string> = {
  flower: 'bravo',
}

const PHONE_FEATURES: Record<string, string> = {
  AA: 'V',
  AE: 'V',
  AH: 'V',
  AO: 'V',
  AW: 'V',
  AY: 'V',
  EH: 'V',
  ER: 'V',
  EY: 'V',
  IH: 'V',
  IY: 'V',
  OW: 'V',
  OY: 'V',
  UH: 'V',
  UW: 'V',
  B: 'P',
  P: 'P',
  CH: 'S',
  F: 'F',
  G: 'K',
  JH: 'S',
  K: 'K',
  D: 'T',
  DH: 'T',
  T: 'T',
  TH: 'T',
  L: 'L',
  R: 'L',
  M: 'N',
  N: 'N',
  NG: 'N',
  S: 'S',
  SH: 'S',
  V: 'F',
  Z: 'S',
  ZH: 'S',
  HH: 'H',
  W: 'V',
  Y: 'V',
}

// Chinese explanation forms are intentionally data, not matching logic. Add
// field-observed forms here without changing the correction algorithm.
export const CHINESE_EXPLANATION_WORDS: ReadonlyArray<{ canonical: string, spoken: string, symbol: string }> = [
  { canonical: 'alpha', spoken: '阿尔法', symbol: 'A' },
  { canonical: 'bravo', spoken: '布拉沃', symbol: 'B' },
  { canonical: 'charlie', spoken: '查理', symbol: 'C' },
  { canonical: 'delta', spoken: '德尔塔', symbol: 'D' },
  { canonical: 'echo', spoken: '埃科', symbol: 'E' },
  { canonical: 'foxtrot', spoken: '福克斯特罗特', symbol: 'F' },
  { canonical: 'golf', spoken: '高尔夫', symbol: 'G' },
  { canonical: 'hotel', spoken: '霍特尔', symbol: 'H' },
  { canonical: 'india', spoken: '印迪亚', symbol: 'I' },
  { canonical: 'juliet', spoken: '朱丽叶', symbol: 'J' },
  { canonical: 'kilo', spoken: '基洛', symbol: 'K' },
  { canonical: 'lima', spoken: '利马', symbol: 'L' },
  { canonical: 'mike', spoken: '迈克', symbol: 'M' },
  { canonical: 'november', spoken: '诺文伯', symbol: 'N' },
  { canonical: 'oscar', spoken: '奥斯卡', symbol: 'O' },
  { canonical: 'papa', spoken: '帕帕', symbol: 'P' },
  { canonical: 'quebec', spoken: '魁北克', symbol: 'Q' },
  { canonical: 'romeo', spoken: '罗密欧', symbol: 'R' },
  { canonical: 'sierra', spoken: '塞拉', symbol: 'S' },
  { canonical: 'tango', spoken: '探戈', symbol: 'T' },
  { canonical: 'uniform', spoken: '尤尼福姆', symbol: 'U' },
  { canonical: 'victor', spoken: '维克托', symbol: 'V' },
  { canonical: 'whiskey', spoken: '威士忌', symbol: 'W' },
  { canonical: 'x-ray', spoken: '埃克斯雷', symbol: 'X' },
  { canonical: 'yankee', spoken: '扬基', symbol: 'Y' },
  { canonical: 'zulu', spoken: '祖鲁', symbol: 'Z' },
]

const CANONICAL_BY_SYMBOL = new Map(Object.entries(NATO_WORDS).map(([word, symbol]) => [symbol, word]))
const ENGLISH_WORDS: ExplanationWord[] = [...Object.entries(NATO_WORDS), ...Object.entries(ALTERNATE_WORDS)]
  .map(([word, symbol]) => ({ canonical: CANONICAL_BY_SYMBOL.get(symbol)!, symbol, word }))
const EXACT_ENGLISH = new Map(ENGLISH_WORDS.map(entry => [entry.word, entry]))
const NATO_EXPLANATION_WORDS = ENGLISH_WORDS.filter(entry => entry.word === entry.canonical)
const cmuDictionary = cmudict.dict()
const tokenCodes = new Map<string, string>()
const englishCorrectionCache = new Map<string, PhoneticCorrection | null>()
const chineseCorrectionCache = new Map<string, PhoneticCorrection | null>()
let englishPhoneEntries: Array<{ entry: ExplanationWord, phoneVariants: string[][] }> | undefined
let chinesePinyinEntries: Array<{ entry: typeof CHINESE_EXPLANATION_WORDS[number], syllables: string[] }> | undefined

export function correctExplanationWord(input: string): PhoneticCorrection | undefined {
  const lower = input.trim().toLowerCase()
  const exact = EXACT_ENGLISH.get(lower)
  if (exact)
    return correction(exact, 0, 'en', 'exact')

  const alias = ENGLISH_ASR_ALIASES[lower]
  if (alias) {
    const target = EXACT_ENGLISH.get(alias)
    if (target)
      return correction(target, 0, 'en', 'alias')
  }

  if (/^[a-z]+(?:-[a-z]+)?$/.test(lower))
    return correctEnglishWord(lower)
  if (/^\p{Script=Han}+$/u.test(input))
    return correctChineseWord(input)
  return undefined
}

// Produces a displayable transcript while preserving all non-explanation
// words and punctuation. Exact English spelling words are left unchanged;
// Chinese explanation forms are rendered as their canonical NATO word.
export function correctExplanationText(input: string): CorrectedExplanationText {
  const corrections: Array<PhoneticCorrection & { source: string }> = []
  const phraseCorrected = correctEnglishPhrases(input, corrections)
  const text = phraseCorrected.replace(/[A-Za-z]+(?:-[A-Za-z]+)?|\p{Script=Han}+/gu, (source) => {
    const correctionResult = correctExplanationWord(source)
    if (!correctionResult || (correctionResult.method === 'exact' && correctionResult.language === 'en'))
      return source
    corrections.push({ ...correctionResult, source })
    return displayCanonical(correctionResult.canonical)
  })
  return { corrections, text }
}

// The LLM sees this auxiliary transcript only for a changed B-prefix
// explanation word. Both Bravo and the common alternate Boston represent B.
export function shouldIncludeCallsignCorrection(original: string, corrected: string): boolean {
  return original !== corrected && /\b(?:bravo|boston)\b/i.test(corrected)
}

export function correctEnglishWord(input: string): PhoneticCorrection | undefined {
  const lower = input.toLowerCase()
  const cached = englishCorrectionCache.get(lower)
  if (cached !== undefined)
    return cached ?? undefined

  const phoneVariants = cmuPhoneVariants(lower)
  if (!phoneVariants) {
    englishCorrectionCache.set(lower, null)
    return undefined
  }

  const bestBySymbol = new Map<string, { distance: number, entry: ExplanationWord }>()
  englishPhoneEntries ??= ENGLISH_WORDS.flatMap((entry) => {
    const entryPhoneVariants = cmuPhoneVariants(entry.word)
    return entryPhoneVariants ? [{ entry, phoneVariants: entryPhoneVariants }] : []
  })
  for (const { entry, phoneVariants: candidateVariants } of englishPhoneEntries) {
    const candidateDistance = Math.min(...phoneVariants.flatMap(inputPhones => candidateVariants.map(candidatePhones => tokenDistance(inputPhones, candidatePhones))))
    const previous = bestBySymbol.get(entry.symbol)
    if (!previous || candidateDistance < previous.distance)
      bestBySymbol.set(entry.symbol, { distance: candidateDistance, entry })
  }
  const ranked = [...bestBySymbol.values()]
    .sort((left, right) => left.distance - right.distance || left.entry.symbol.localeCompare(right.entry.symbol))
  const best = ranked[0]
  const runnerUp = ranked[1]
  if (!best || best.distance > 1 || (runnerUp && runnerUp.distance === best.distance)) {
    englishCorrectionCache.set(lower, null)
    return undefined
  }
  const result = correction(best.entry, best.distance, 'en', 'cmudict')
  englishCorrectionCache.set(lower, result)
  return result
}

export function correctChineseWord(input: string): PhoneticCorrection | undefined {
  const cached = chineseCorrectionCache.get(input)
  if (cached !== undefined)
    return cached ?? undefined

  const syllables = pinyinSyllables(input)
  if (syllables.length < 2) {
    chineseCorrectionCache.set(input, null)
    return undefined
  }

  chinesePinyinEntries ??= CHINESE_EXPLANATION_WORDS
    .map(entry => ({ entry, syllables: pinyinSyllables(entry.spoken) }))
  const ranked = chinesePinyinEntries
    .filter(({ syllables: candidateSyllables }) => candidateSyllables.length === syllables.length)
    .map(({ entry, syllables: candidateSyllables }) => ({ distance: tokenDistance(syllables, candidateSyllables), entry }))
    .sort((left, right) => left.distance - right.distance || left.entry.symbol.localeCompare(right.entry.symbol))
  const best = ranked[0]
  const runnerUp = ranked[1]
  // Tone-free pinyin already unifies common ASR character substitutions such
  // as 补拉窝/布拉沃. Allowing even one syllable substitution makes ordinary
  // Chinese short phrases (for example 是吗) collide with explanation words.
  if (!best || best.distance !== 0 || (runnerUp && runnerUp.distance === best.distance)) {
    chineseCorrectionCache.set(input, null)
    return undefined
  }
  const result: PhoneticCorrection = {
    canonical: best.entry.canonical,
    distance: best.distance,
    language: 'zh',
    matched: best.entry.spoken,
    method: input === best.entry.spoken ? 'exact' : 'pinyin',
    symbol: best.entry.symbol,
  }
  chineseCorrectionCache.set(input, result)
  return result
}

export function cmuPhones(word: string): string[] | undefined {
  return cmuPhoneVariants(word)?.[0]
}

export function cmuPhoneVariants(word: string): string[][] | undefined {
  return cmuDictionary[word.toLowerCase()]?.map(pronunciation => pronunciation.map(phone => phone.replace(/[012]$/, '')))
}

export function pinyinSyllables(text: string): string[] {
  return pinyin(text, { removeNonZh: true, toneType: 'none', type: 'array' }) as string[]
}

export function tokenDistance(left: string[], right: string[]): number {
  return distance(encodeTokens(left), encodeTokens(right))
}

export function featurePhoneDistance(left: string[], right: string[]): number {
  return tokenDistance(phoneFeatures(left), phoneFeatures(right))
}

function encodeTokens(tokens: string[]): string {
  return tokens.map((token) => {
    let code = tokenCodes.get(token)
    if (!code) {
      const point = 0xE000 + tokenCodes.size
      if (point > 0xF8FF)
        throw new Error('phonetic token vocabulary exceeded private-use encoding range')
      code = String.fromCharCode(point)
      tokenCodes.set(token, code)
    }
    return code
  }).join('')
}

function correction(entry: ExplanationWord, correctionDistance: number, language: 'en' | 'zh', method: PhoneticCorrection['method']): PhoneticCorrection {
  return {
    canonical: entry.canonical,
    distance: correctionDistance,
    language,
    matched: entry.word,
    method,
    symbol: entry.symbol,
  }
}

function displayCanonical(word: string): string {
  return word[0]!.toUpperCase() + word.slice(1)
}

function correctEnglishPhrases(text: string, corrections: Array<PhoneticCorrection & { source: string }>): string {
  const words = [...text.matchAll(/[A-Za-z]+(?:-[A-Za-z]+)?/gu)]
    .map(match => ({ end: match.index! + match[0].length, source: match[0], start: match.index! }))
  let output = ''
  let cursor = 0
  for (let index = 0; index < words.length;) {
    let replacement: { correction: PhoneticCorrection, end: number, source: string, start: number, wordCount: number } | undefined
    for (const wordCount of [3, 2]) {
      const window = words.slice(index, index + wordCount)
      if (window.length !== wordCount || !isContinuousPhrase(text, window)
        || window.some(word => word.source.length < 3 || EXACT_ENGLISH.has(word.source.toLowerCase()))) {
        continue
      }
      const start = window[0]!.start
      const end = window.at(-1)!.end
      if (!hasPhoneticContext(text, start, end - start))
        continue
      const correctionResult = correctEnglishPhrase(window.map(word => word.source))
      if (correctionResult) {
        replacement = { correction: correctionResult, end, source: text.slice(start, end), start, wordCount }
        break
      }
    }
    if (!replacement) {
      index++
      continue
    }
    output += text.slice(cursor, replacement.start)
    output += displayCanonical(replacement.correction.canonical)
    cursor = replacement.end
    corrections.push({ ...replacement.correction, source: replacement.source })
    index += replacement.wordCount
  }
  return output + text.slice(cursor)
}

function correctEnglishPhrase(words: string[]): PhoneticCorrection | undefined {
  const inputVariants = words.reduce<string[][]>((variants, word) => {
    const wordVariants = cmuPhoneVariants(word)
    if (!wordVariants)
      return []
    return variants.flatMap(prefix => wordVariants.map(phones => [...prefix, ...phones]))
  }, [[]])
  if (inputVariants.length === 0)
    return undefined

  const bestBySymbol = new Map<string, { distance: number, entry: ExplanationWord }>()
  for (const entry of NATO_EXPLANATION_WORDS) {
    const candidateVariants = cmuPhoneVariants(entry.word)
    if (!candidateVariants)
      continue
    const candidateDistance = Math.min(...inputVariants.flatMap(inputPhones => candidateVariants.map(candidatePhones => featurePhoneDistance(inputPhones, candidatePhones))))
    const previous = bestBySymbol.get(entry.symbol)
    if (!previous || candidateDistance < previous.distance)
      bestBySymbol.set(entry.symbol, { distance: candidateDistance, entry })
  }
  const ranked = [...bestBySymbol.values()]
    .sort((left, right) => left.distance - right.distance || left.entry.symbol.localeCompare(right.entry.symbol))
  const best = ranked[0]
  const runnerUp = ranked[1]
  if (!best || best.distance > 1 || (runnerUp && runnerUp.distance === best.distance))
    return undefined
  return correction(best.entry, best.distance, 'en', 'cmudict-window')
}

function isContinuousPhrase(text: string, words: Array<{ end: number, start: number }>): boolean {
  return words.slice(1).every((word, index) => /^\s+$/.test(text.slice(words[index]!.end, word.start)))
}

function phoneFeatures(phones: string[]): string[] {
  return phones.map(phone => PHONE_FEATURES[phone] ?? phone)
}

function hasPhoneticContext(text: string, offset: number, length: number): boolean {
  const window = text.slice(Math.max(0, offset - 60), Math.min(text.length, offset + length + 60))
  let explanationTokens = 0
  for (const token of window.match(/[A-Za-z]+(?:-[A-Za-z]+)?|\d/gu) ?? []) {
    if (/^\d$/.test(token) || correctExplanationWord(token))
      explanationTokens++
  }
  return explanationTokens >= 4
}
