// 手动验证常见呼号相似度：npm run callsign-match-test -- "语音识别文本"
import process from 'node:process'
import { config as loadEnv } from 'dotenv'
import { CallsignHintMatcher } from '../src/ai/callsign-hints.js'
import { loadAiConfig } from '../src/config.js'

loadEnv({ quiet: true })

const text = process.argv.slice(2).join(' ').trim()
if (!text) {
  console.error('用法: npm run callsign-match-test -- "语音识别文本"')
  process.exit(1)
}

const config = loadAiConfig()
const matcher = new CallsignHintMatcher(config.callsignsFile)
const groups = matcher.match(text)
interface CandidateMatch {
  callsign: string
  distance: number
  score: number
  source: string
}

const candidatesByCallsign = new Map<string, CandidateMatch>()
for (const group of groups) {
  for (const candidate of group.candidates) {
    if (candidate.distance > 1)
      continue
    const previous = candidatesByCallsign.get(candidate.callsign)
    if (!previous || candidate.score > previous.score
      || (candidate.score === previous.score && candidate.distance < previous.distance)) {
      candidatesByCallsign.set(candidate.callsign, { ...candidate, source: group.source })
    }
  }
}

const matches = [...candidatesByCallsign.values()]
  .sort((left, right) => right.score - left.score || left.distance - right.distance || left.callsign.localeCompare(right.callsign))

console.log(JSON.stringify({
  candidates: matches.map(({ callsign, distance, score }) => ({ callsign, distance, score })),
  source: [...new Set(matches.map(match => match.source))],
}, null, 2))
