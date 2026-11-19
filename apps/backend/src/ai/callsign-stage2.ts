import type { SpeakerMatch } from '@iaxweb/contracts'
import type { CallsignContext } from './callsign-evidence.js'
import { CALLSIGN_PATTERN } from '@iaxweb/contracts'
import { checkCallsignDecision, hasCurrentCompactSelfQuote, supportedSelfEvidence } from './callsign-speaker.js'
import { compileSchema } from './schema-validator.js'

export const CALLSIGN_STAGE2_PROMPT = `你负责为业余无线电通联的主叫识别补足证据。现有文字流程已经检查 current、history 和字母解释法 candidates，尚未确认主叫。检查当前文字的角色关系，再按下面的条件利用特征匹配 featureMatches。特征匹配指当前声音与已标注录音的比对结果。

【文字优先】
- 当前明确自报了另一个呼号，或当前明确把匹配呼号当作被叫、复述、确认或第三方时，拒绝使用该匹配。集体台和客席操作时，同一个人的声音可能对应不同呼号，必须以本轮文字表明的呼号为准。
- 「这里是」「我是」「我的呼号」「this is」或 CQ 中清楚的自报可以证明讲话人。只说「收到」「您的信号不错」或只说 CQ 没报呼号，属于文字未确定讲话人，仍可使用符合要求的特征匹配。历史拼读只证明呼号字符。
- 自报清楚且与匹配呼号一致时，讲话人依据必须引用当前自报原文。完整呼号优先用对应的解释法候选。corrected 仅供核对原文。

【特征匹配】
- 先数 featureMatches 中全部不同呼号。达到两个或更多时，全部只作参考。唯一 low 或 null 时，也只作参考。以上情况都不能把匹配当作任何依据。
- 唯一 medium，且当前文字无法确定讲话人、没有明确冲突时：只要有同一呼号的字母解释法候选就确认主叫。speakerEvidence 引用该匹配，callsignEvidence 引用拼读候选。没有对应拼读则拒绝。
- 唯一 high，且没有文字冲突时：可直接为仍缺少的依据提供证据。即使本轮没有任何自报、也没有拼读，仍可以确认这个唯一高置信度呼号，两项依据都引用同一个 matchId。若文字已经能证明其中一项，优先引用该项的文字依据。请勿因为只有「收到，您的信号很清楚」之类的普通对话而拒绝唯一 high。
- 两项证据必须指向一个完整呼号。任何引用 ID 都必须在本次输入存在。

【输出】
仅输出 JSON。确认时输出 speaker 为 self、全大写 callsign、speakerEvidence、callsignEvidence。讲话人文字依据用 {"source":"text","quote":"当前原文逐字片段"}，完整呼号拼读依据用 {"source":"spelling","candidateId":1}，特征匹配依据用 {"source":"featureMatch","matchId":1}。没有足够依据时仅输出 {"speaker":"unknown"}；明确只有对方身份时可输出 {"speaker":"other"}。

例如当前是「收到，您的信号很清楚」，唯一匹配为高置信度 BG5XYZ，编号 1，且没有拼读候选，应输出
{"speaker":"self","callsign":"BG5XYZ","speakerEvidence":{"source":"featureMatch","matchId":1},"callsignEvidence":{"source":"featureMatch","matchId":1}}
同一句话若唯一匹配为中置信度，且历史有 BG5XYZ 的拼读候选 2，应输出
{"speaker":"self","callsign":"BG5XYZ","speakerEvidence":{"source":"featureMatch","matchId":1},"callsignEvidence":{"source":"spelling","candidateId":2}}
如果当前明确说「我抄收您的呼号是 BG5XYZ」，即使唯一匹配是高置信度 BG5XYZ，也应输出 {"speaker":"other"}。`

const matchEvidence = {
  type: 'object',
  additionalProperties: false,
  required: ['source', 'matchId'],
  properties: { source: { const: 'featureMatch' }, matchId: { const: 1 } },
}

export const callsignStage2Schema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['speaker', 'callsign', 'speakerEvidence', 'callsignEvidence'],
      properties: {
        speaker: { const: 'self' },
        callsign: { type: 'string', pattern: CALLSIGN_PATTERN.source },
        speakerEvidence: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              required: ['source', 'quote'],
              properties: { source: { const: 'text' }, quote: { type: 'string', minLength: 1 } },
            },
            matchEvidence,
          ],
        },
        callsignEvidence: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              required: ['source', 'candidateId'],
              properties: { source: { const: 'spelling' }, candidateId: { type: 'integer', minimum: 1 } },
            },
            matchEvidence,
          ],
        },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['speaker'],
      properties: { speaker: { enum: ['other', 'unknown'] } },
    },
  ],
}

const validateStage2 = compileSchema(callsignStage2Schema)

type Match = Pick<SpeakerMatch, 'callsign' | 'confidence'>
type Stage2Match = Pick<Match, 'callsign'> & { id: 1, confidence: 'medium' | 'high' }
interface MatchEvidence { source: 'featureMatch', matchId: 1 }
interface Stage2Decision {
  speaker: 'self'
  callsign: string
  speakerEvidence: { source: 'text', quote: string } | MatchEvidence
  callsignEvidence: { source: 'spelling', candidateId: number } | MatchEvidence
}

export function selectStage2Match(context: CallsignContext, matches: readonly Match[]): Stage2Match | undefined {
  const [match] = matches
  // Count every returned callsign, including those with low or null confidence.
  if (matches.length !== 1 || !match || (match.confidence !== 'high' && match.confidence !== 'medium'))
    return undefined
  if (match.confidence === 'medium' && !context.candidates.some(candidate => candidate.callsign === match.callsign))
    return undefined
  if (explicitFeatureConflict(context, match.callsign) || supportedSelfEvidence(context).length > 0)
    return undefined
  if (match.confidence === 'medium' && hasExplicitSelfCallsign(context.current.text, match.callsign))
    return undefined
  return { id: 1, callsign: match.callsign, confidence: match.confidence }
}

export function checkStage2Callsign(output: Record<string, unknown> | undefined, context: CallsignContext, match: Stage2Match): string | undefined {
  if (!output || output.speaker !== 'self' || validateStage2(output))
    return undefined
  const { callsign, speakerEvidence, callsignEvidence } = output as unknown as Stage2Decision
  if (speakerEvidence.source === 'text' && callsignEvidence.source === 'spelling') {
    return checkCallsignDecision({ speaker: 'self', callsign, quote: speakerEvidence.quote, evidence: callsignEvidence.candidateId }, context).callsign
  }
  if (callsign !== match.callsign)
    return undefined
  if (speakerEvidence.source === 'text') {
    if (!hasCurrentCompactSelfQuote(context.current.text, speakerEvidence.quote, callsign))
      return undefined
  }
  else if (hasExplicitSelfCallsign(context.current.text, callsign)) {
    return undefined
  }
  if (callsignEvidence.source === 'spelling') {
    return context.candidates.some(candidate => candidate.id === callsignEvidence.candidateId && candidate.callsign === callsign)
      ? callsign
      : undefined
  }
  if (match.confidence !== 'high' || context.candidates.some(candidate => candidate.callsign === callsign))
    return undefined
  return callsign
}

function hasExplicitSelfCallsign(text: string, callsign: string): boolean {
  return compactIntroductions(text).some(match => match[1]!.toUpperCase() === callsign
    && hasCurrentCompactSelfQuote(text, match[0], callsign))
}

function compactIntroductions(text: string): RegExpMatchArray[] {
  return [...text.matchAll(/(?:这里是|我是|我的(?:电台)?呼号(?:是|为)?|\bthis\s+is\b|\bmy\s+call(?:sign)?(?:\s+is)?\b|\bCQ\b)[\s:：,，]*(B[ADGHIY]\d[A-Z]{2,3})(?![A-Z0-9])/gi)]
}

function explicitFeatureConflict(context: CallsignContext, callsign: string): boolean {
  const { current: { id, text }, candidates } = context
  const conflictingSelf = compactIntroductions(text).some(match => match[1]!.toUpperCase() !== callsign
    && hasCurrentCompactSelfQuote(text, match[0], match[1]!.toUpperCase()))
  if (conflictingSelf)
    return true
  const other = /(?:(?:您|你|对方)的?呼号|我(?:抄收|抄到|拷贝)(?:(?:您|你)的?呼号)?)(?:是|为)?[\s:：]*(B[ADGHIY]\d[A-Z]{2,3})(?![A-Z0-9])/gi
  if ([...text.matchAll(other)].some(match => match[1]!.toUpperCase() === callsign))
    return true
  const otherSpelling = /(?:(?:您|你|对方)的?呼号|我(?:抄收|抄到|拷贝)(?:(?:您|你)的?呼号)?)(?:是|为)?[\s:：]*$/
  return candidates.some(candidate => candidate.segmentId === id && candidate.callsign === callsign
    && otherSpelling.test(text.slice(0, candidate.start)))
}
