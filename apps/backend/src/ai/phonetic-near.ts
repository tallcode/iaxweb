import { CHINESE_EXPLANATION_WORDS, cmuPhoneVariants, pinyinSyllables } from './phonetic-corrector.js'
import { nearPhoneData } from './phonetic-data/data.js'
import { eligibleUnknown, spellingGate, tokenize } from './phonetic-near-context.js'

export interface NearSpellingCorrection {
  source: string
  replacement: string
  start: number
  end: number
  method: 'ipa-near'
  distance: number
  margin: number
}
interface Match { symbol: string, distance: number, margin: number }
const canonical = new Map(CHINESE_EXPLANATION_WORDS.map(word => [word.symbol, word.canonical]))
const pinyinKeys = Object.keys(nearPhoneData.pinyin).sort((a, b) => b.length - a.length)
const cache = new Map<string, Match | undefined>()
const CACHE_LIMIT = 512
// Strict development profile: keep the previously demonstrated benefit while
// declining weaker similarities. These distances are not probabilities.
const MAX_DISTANCE = 0.08
const MIN_MARGIN = 0.08

function readPhones(source: string): number[][] {
  if (/^\p{Script=Han}+$/u.test(source)) {
    const phones: number[] = []
    for (const syllable of pinyinSyllables(source)) {
      let remaining = syllable.replace(/v/g, 'ü').normalize('NFD')
      while (remaining) {
        const key = pinyinKeys.find(key => remaining.startsWith(key))
        const units = key === undefined ? undefined : nearPhoneData.pinyin[key]
        if (!key || !units)
          return []
        phones.push(...units)
        remaining = remaining.slice(key.length)
      }
    }
    return phones.length ? [phones] : []
  }
  return (cmuPhoneVariants(source) ?? []).flatMap((variant) => {
    const parts = variant.map(phone => nearPhoneData.arpabet[phone])
    return parts.includes(undefined) ? [] : [parts.flatMap(part => part!)]
  })
}

function distance(source: number[], target: number[]): number {
  if (Math.abs(source.length - target.length) > 1)
    return Number.POSITIVE_INFINITY
  // The two layers allow at most one insertion/deletion in the whole word.
  let plain = new Float64Array(target.length + 1).fill(Number.POSITIVE_INFINITY)
  let edited = new Float64Array(target.length + 1).fill(Number.POSITIVE_INFINITY)
  plain[0] = 0
  if (target.length)
    edited[1] = 1
  for (let i = 0; i < source.length; i++) {
    const nextPlain = new Float64Array(target.length + 1).fill(Number.POSITIVE_INFINITY)
    const nextEdited = new Float64Array(target.length + 1).fill(Number.POSITIVE_INFINITY)
    if (i === 0)
      nextEdited[0] = 1
    for (let j = 1; j <= target.length; j++) {
      const cost = nearPhoneData.substitutions[source[i]!]![target[j - 1]!]!
      nextPlain[j] = plain[j - 1]! + cost
      nextEdited[j] = Math.min(edited[j - 1]! + cost, plain[j]! + 1, nextPlain[j - 1]! + 1)
    }
    plain = nextPlain
    edited = nextEdited
  }
  return Math.min(plain[target.length]!, edited[target.length]!) / Math.max(source.length, target.length, 1)
}

function match(source: string): Match | undefined {
  if (cache.has(source))
    return cache.get(source)
  const variants = readPhones(source)
  const bestBySymbol = new Map<string, number>()
  for (const template of nearPhoneData.templates) {
    const cost = Math.min(...variants.map(phones => distance(phones, template.phones)))
    if (cost < (bestBySymbol.get(template.symbol) ?? Number.POSITIVE_INFINITY))
      bestBySymbol.set(template.symbol, cost)
  }
  const ranked = [...bestBySymbol].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
  const first = ranked[0]
  const second = ranked[1]
  const result = first && second && first[1] <= MAX_DISTANCE && second[1] - first[1] >= MIN_MARGIN
    ? { symbol: first[0], distance: first[1], margin: second[1] - first[1] }
    : undefined
  if (cache.size >= CACHE_LIMIT)
    cache.delete(cache.keys().next().value!)
  cache.set(source, result)
  return result
}

export function nearSpellingCorrections(text: string): NearSpellingCorrection[] {
  const tokens = tokenize(text)
  const corrections: NearSpellingCorrection[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (!eligibleUnknown(token) || !spellingGate(text, tokens, i).allowed)
      continue
    const found = match(token.source)
    if (!found)
      continue
    corrections.push({ source: token.source, replacement: canonical.get(found.symbol)!, start: token.start, end: token.end, method: 'ipa-near', distance: Number(found.distance.toFixed(6)), margin: Number(found.margin.toFixed(6)) })
    if (corrections.length >= 5)
      break
  }
  return corrections
}
