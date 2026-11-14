/** Text boundaries for conservative near-sound evidence; no audio/model calls. */
import { CHINESE_EXPLANATION_WORDS, correctExplanationWord, pinyinSyllables } from './phonetic-corrector.js'

export interface Token { source: string, start: number, end: number, symbol?: string | undefined, strong: boolean, kind: 'word' | 'digit' | 'unknown' | 'compact' | 'boundary' }
export interface Gate { allowed: boolean, reason: string, anchors: number }
const digits: Record<string, string> = { zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', 零: '0', 洞: '0', 一: '1', 幺: '1', 二: '2', 两: '2', 三: '3', 四: '4', 五: '5', 六: '6', 拐: '7', 七: '7', 八: '8', 九: '9', 勾: '9' }
const markers = ['字母解释法', '解释法', '这里是', '重复一遍', '再报一遍', '后缀', '尾号', '拼读', '我是', '这里', '呼叫', '信号', '收到', '谢谢', '设备', '请问', '是否', '是吧', '好吧', '那个']
const chineseEntries = CHINESE_EXPLANATION_WORDS.map(row => ({ ...row, syllables: pinyinSyllables(row.spoken) })).sort((a, b) => b.syllables.length - a.syllables.length)

export function tokenize(text: string): Token[] {
  const output: Token[] = []
  const pattern = /\b[A-Z][-A-Z]*\d[-\dA-Z]*\b|\bX[ \t-]+Ray\b|[A-Z]+(?:-[A-Z]+)?|\p{Script=Han}+|[\d。！？!?;.]/giu
  for (const match of text.matchAll(pattern)) {
    const source = match[0]
    const start = match.index
    if (/^[。！？!?;.]$/u.test(source)) {
      output.push({ source, start, end: start + source.length, strong: false, kind: 'boundary' })
      continue
    }
    if (/^[A-Z][-A-Z]*\d[-\dA-Z]*$/i.test(source)) {
      output.push({ source, start, end: start + source.length, strong: false, kind: 'compact' })
      continue
    }
    if (/^\p{Script=Han}+$/u.test(source)) {
      let offset = 0
      // Compute pinyin once per Chinese run, and only look up a word after
      // a known syllable sequence matches. Do not cache every prose n-gram.
      const syllables = pinyinSyllables(source)
      const knownAt = (position: number) => {
        if (syllables.length !== source.length)
          return undefined
        const entry = chineseEntries.find(row => row.syllables.every((syllable, i) => syllables[position + i] === syllable))
        if (!entry)
          return undefined
        return { piece: source.slice(position, position + entry.spoken.length), symbol: entry.symbol }
      }
      while (offset < source.length) {
        const marker = markers.find(word => source.startsWith(word, offset))
        const known = knownAt(offset)
        const digit = digits[source[offset]!]
        if (marker) {
          output.push({ source: marker, start: start + offset, end: start + offset + marker.length, strong: false, kind: 'boundary' })
          offset += marker.length
        }
        else if (known) {
          output.push({ source: known.piece, start: start + offset, end: start + offset + known.piece.length, symbol: known.symbol, strong: true, kind: 'word' })
          offset += known.piece.length
        }
        else if (digit) {
          output.push({ source: source[offset]!, start: start + offset, end: start + offset + 1, symbol: digit, strong: false, kind: 'digit' })
          offset++
        }
        else {
          let end = offset + 1
          while (end < source.length && !knownAt(end) && !digits[source[end]!] && !markers.some(word => source.startsWith(word, end)))
            end++
          output.push({ source: source.slice(offset, end), start: start + offset, end: start + end, strong: false, kind: 'unknown' })
          offset = end
        }
      }
      continue
    }
    if (/^(?:over|cq|qth|qsl|qrz|roger|calling)$/i.test(source)) {
      output.push({ source, start, end: start + source.length, strong: false, kind: 'boundary' })
      continue
    }
    const digit = digits[source.toLowerCase()] ?? (/^\d$/.test(source) ? source : undefined)
    const found = source.length > 1 && !digit ? correctExplanationWord(source) : undefined
    output.push({ source, start, end: start + source.length, symbol: digit ?? found?.symbol, strong: found?.method === 'exact', kind: digit ? 'digit' : found ? 'word' : 'unknown' })
  }
  return output
}

export function eligibleUnknown(token: Token): boolean {
  return token.kind === 'unknown' && (/^\p{Script=Han}{2,5}$/u.test(token.source) || /^[A-Z]{2,24}(?:-[A-Z]+)?$/i.test(token.source))
}

export function spellingGate(text: string, tokens: Token[], index: number): Gate {
  const token = tokens[index]!
  const left: Token[] = []
  const right: Token[] = []
  for (let i = index - 1; i >= 0; i--) {
    const next = tokens[i]!
    const following = left[0] ?? token
    if (!next.symbol || !/^[\s,，、:：-]*$/u.test(text.slice(next.end, following.start)))
      break
    left.unshift(next)
  }
  for (let i = index + 1; i < tokens.length; i++) {
    const next = tokens[i]!
    const previous = right.at(-1) ?? token
    if (!next.symbol || !/^[\s,，、:：-]*$/u.test(text.slice(previous.end, next.start)))
      break
    right.push(next)
  }
  const anchors = [...left, ...right].filter(row => row.strong).length
  const previousClause = text.slice(Math.max(0, token.start - 28), token.start).split(/[。！？!?;]/u).at(-1) ?? ''
  const explicit = /字母解释法|解释法|尾号|后缀|拼读/u.test(previousClause)
  const bothSides = left.some(row => row.strong) && right.some(row => row.strong)
  const prefix = /^B[ADGHIY]\d[A-Z]*$/.test(left.map(row => row.symbol).join(''))
  if (anchors >= 2 && bothSides)
    return { allowed: true, reason: 'between-spelling-anchors', anchors }
  if (explicit && anchors >= 1)
    return { allowed: true, reason: 'explicit-spelling-and-anchor', anchors }
  if (anchors >= 3 && prefix)
    return { allowed: true, reason: 'bounded-trailing-spelling-slot', anchors }
  return { allowed: false, reason: 'insufficient-spelling-context', anchors }
}
