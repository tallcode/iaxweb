import type { SpeakerMatch } from '@iaxweb/contracts'
import type { TranscriptTurn } from '../../src/ai/callsign-evidence.js'

export interface CallsignRegressionCase {
  id: string
  category: string
  transcript: string
  expected: string | null
  evidenceTurns: TranscriptTurn[]
  featureMatches: Array<Pick<SpeakerMatch, 'callsign' | 'confidence'>>
  expectedSources?: string[]
}

export const CALLSIGN_REGRESSION_CASES: CallsignRegressionCase[] = [
  {
    id: 'medium-reply-to-confirmation',
    category: '普通抄收确认结合历史拼读补讲话人',
    transcript: '您抄收的完全正确。我使用的是手台，五瓦发射功率。',
    expected: 'BG5XYZ',
    evidenceTurns: [
      { id: 'earlier', text: '这里是 Bravo Golf Five X Ray Yankee Zulu。' },
      { id: 'other', text: 'BG5XYZ，我抄收您的 QTH 在市区，是否正确？' },
    ],
    featureMatches: [{ callsign: 'BG5XYZ', confidence: 'medium' }],
    expectedSources: ['featureMatch', 'spelling'],
  },
  {
    id: 'high-only',
    category: '无自报，唯一高',
    transcript: '好的，您的信号很清楚，祝您通联愉快。',
    expected: null,
    evidenceTurns: [],
    featureMatches: [
      {
        callsign: 'BG5XYZ',
        confidence: 'high',
      },
    ],
  },
  {
    id: 'medium-with-history',
    category: '未明确自报，唯一中加历史拼读',
    transcript: '收到，今天的传播比昨天好多了。',
    expected: 'BG5XYZ',
    evidenceTurns: [
      {
        id: 'history-xyz',
        text: '这里是 Bravo Golf Five X Ray Yankee Zulu。',
      },
    ],
    featureMatches: [
      {
        callsign: 'BG5XYZ',
        confidence: 'medium',
      },
    ],
    expectedSources: [
      'featureMatch',
      'spelling',
    ],
  },
  {
    id: 'medium-without-spelling',
    category: '无拼读，唯一中',
    transcript: '您的信号不错，我在市区。',
    expected: null,
    evidenceTurns: [],
    featureMatches: [
      {
        callsign: 'BG5XYZ',
        confidence: 'medium',
      },
    ],
  },
  {
    id: 'medium-mismatched-spelling',
    category: '唯一中与历史拼读不对应',
    transcript: '收到，您的信号不错。',
    expected: null,
    evidenceTurns: [
      {
        id: 'history-abc',
        text: '这里是 Bravo Golf Five Alpha Bravo Charlie。',
      },
    ],
    featureMatches: [
      {
        callsign: 'BG5XYZ',
        confidence: 'medium',
      },
    ],
  },
  {
    id: 'low-with-history',
    category: '唯一低不可补身份',
    transcript: '收到，您的信号不错。',
    expected: null,
    evidenceTurns: [
      {
        id: 'history-xyz',
        text: '这里是 Bravo Golf Five X Ray Yankee Zulu。',
      },
    ],
    featureMatches: [
      {
        callsign: 'BG5XYZ',
        confidence: 'low',
      },
    ],
  },
  {
    id: 'low-with-conflicting-text',
    category: '低置信度与明确自报冲突',
    transcript: 'CQ CQ，这里是 Bravo Golf Five Alpha Bravo Charlie。',
    expected: 'BG5ABC',
    evidenceTurns: [],
    featureMatches: [
      {
        callsign: 'BG5XYZ',
        confidence: 'low',
      },
    ],
    expectedSources: [
      'text',
      'spelling',
    ],
  },
  {
    id: 'high-and-low',
    category: '一高一低均降级',
    transcript: '收到，您的信号不错。',
    expected: null,
    evidenceTurns: [],
    featureMatches: [
      {
        callsign: 'BG5XYZ',
        confidence: 'high',
      },
      {
        callsign: 'BG5ABC',
        confidence: 'low',
      },
    ],
  },
  {
    id: 'high-and-null',
    category: '一高一未达到置信度也降级',
    transcript: '收到，您的信号不错。',
    expected: null,
    evidenceTurns: [],
    featureMatches: [
      {
        callsign: 'BG5XYZ',
        confidence: 'high',
      },
      {
        callsign: 'BG5ABC',
        confidence: null,
      },
    ],
  },
  {
    id: 'multiple-with-clear-text',
    category: '多个匹配时文字仍独立有效',
    transcript: 'CQ CQ，这里是 Bravo Golf Five Alpha Bravo Charlie。',
    expected: 'BG5ABC',
    evidenceTurns: [],
    featureMatches: [
      {
        callsign: 'BG5XYZ',
        confidence: 'high',
      },
      {
        callsign: 'BG5KLM',
        confidence: 'medium',
      },
    ],
    expectedSources: [
      'text',
      'spelling',
    ],
  },
  {
    id: 'medium-and-low',
    category: '多个匹配不能补中置信度身份',
    transcript: '收到，您的信号不错。',
    expected: 'BG5XYZ',
    evidenceTurns: [
      {
        id: 'history-xyz',
        text: '这里是 Bravo Golf Five X Ray Yankee Zulu。',
      },
    ],
    featureMatches: [
      {
        callsign: 'BG5XYZ',
        confidence: 'medium',
      },
      {
        callsign: 'BG5ABC',
        confidence: 'low',
      },
    ],
    expectedSources: [
      'featureMatch',
      'spelling',
    ],
  },
  {
    id: 'high-confirmed-other',
    category: '高置信度不能覆盖被叫身份',
    transcript: '我抄收您的呼号是 BG5XYZ，是否正确？',
    expected: null,
    evidenceTurns: [],
    featureMatches: [
      {
        callsign: 'BG5XYZ',
        confidence: 'high',
      },
    ],
  },
  {
    id: 'high-club-operator',
    category: '集体台明确使用本轮呼号',
    transcript: '这里是 Bravo Golf Five Alpha Bravo Charlie，今天我在集体台值机。',
    expected: 'BG5ABC',
    evidenceTurns: [],
    featureMatches: [
      {
        callsign: 'BG5XYZ',
        confidence: 'high',
      },
    ],
    expectedSources: [
      'text',
      'spelling',
    ],
  },
  {
    id: 'high-guest-compact',
    category: '客席自报的紧凑呼号与特征冲突',
    transcript: '我是客席操作员，今天使用台站呼号 CQ CQ，这里是 BG5ABC。',
    expected: null,
    evidenceTurns: [],
    featureMatches: [
      {
        callsign: 'BG5XYZ',
        confidence: 'high',
      },
    ],
  },
  {
    id: 'high-spelling-fallback',
    category: '紧凑自报同一呼号，唯一高补呼号',
    transcript: 'CQ CQ，这里是 BG5XYZ，呼叫频率上的友台。',
    expected: 'BG5XYZ',
    evidenceTurns: [],
    featureMatches: [
      {
        callsign: 'BG5XYZ',
        confidence: 'high',
      },
    ],
    expectedSources: [
      'text',
      'featureMatch',
    ],
  },
  {
    id: 'high-with-history',
    category: '唯一高补身份，优先引用历史拼读',
    transcript: '好的，这边信号都是五九。',
    expected: 'BG5XYZ',
    evidenceTurns: [
      {
        id: 'history-xyz',
        text: '这里是 Bravo Golf Five X Ray Yankee Zulu。',
      },
    ],
    featureMatches: [
      {
        callsign: 'BG5XYZ',
        confidence: 'high',
      },
    ],
    expectedSources: [
      'featureMatch',
      'spelling',
    ],
  },
  {
    id: 'medium-clear-history',
    category: '中置信度不能取代已有文本自报',
    transcript: '这里是 BG5XYZ，收到您的声音。',
    expected: 'BG5XYZ',
    evidenceTurns: [
      {
        id: 'history-xyz',
        text: '这里是 Bravo Golf Five X Ray Yankee Zulu。',
      },
    ],
    featureMatches: [
      {
        callsign: 'BG5XYZ',
        confidence: 'medium',
      },
    ],
    expectedSources: [
      'text',
      'spelling',
    ],
  },
  {
    id: 'medium-confirmed-other',
    category: '中置信度不能覆盖当前抄收关系',
    transcript: '我抄收您的呼号是 BG5XYZ，对吧？',
    expected: null,
    evidenceTurns: [
      {
        id: 'history-xyz',
        text: '这里是 Bravo Golf Five X Ray Yankee Zulu。',
      },
    ],
    featureMatches: [
      {
        callsign: 'BG5XYZ',
        confidence: 'medium',
      },
    ],
  },
  {
    id: 'high-multiple-high',
    category: '两个高置信度只作参考',
    transcript: '收到，您的信号不错。',
    expected: null,
    evidenceTurns: [],
    featureMatches: [
      {
        callsign: 'BG5XYZ',
        confidence: 'high',
      },
      {
        callsign: 'BG5ABC',
        confidence: 'high',
      },
    ],
  },
  {
    id: 'high-history-full',
    category: 'high-history-full',
    transcript: '我用的是手台，五瓦发射功率。',
    expected: 'BG5XYZ',
    evidenceTurns: [
      {
        id: 'other-speaker',
        text: 'BG5XYZ，你用的是什么设备？',
      },
    ],
    featureMatches: [
      {
        callsign: 'BG5XYZ',
        confidence: 'high',
      },
    ],
    expectedSources: [
      'featureMatch',
      'featureMatch',
    ],
  },
  {
    id: 'high-history-district-suffix',
    category: 'high-history-district-suffix',
    transcript: '我用的是手台，五瓦发射功率。',
    expected: 'BG5XYZ',
    evidenceTurns: [
      {
        id: 'other-speaker',
        text: '5XYZ，你用的是什么设备？',
      },
    ],
    featureMatches: [
      {
        callsign: 'BG5XYZ',
        confidence: 'high',
      },
    ],
    expectedSources: [
      'featureMatch',
      'featureMatch',
    ],
  },
  {
    id: 'high-history-suffix',
    category: 'high-history-suffix',
    transcript: '我用的是手台，五瓦发射功率。',
    expected: 'BG5XYZ',
    evidenceTurns: [
      {
        id: 'other-speaker',
        text: 'XYZ，你用的是什么设备？',
      },
    ],
    featureMatches: [
      {
        callsign: 'BG5XYZ',
        confidence: 'high',
      },
    ],
    expectedSources: [
      'featureMatch',
      'featureMatch',
    ],
  },
  {
    id: 'high-current-suffix',
    category: 'high-current-suffix',
    transcript: 'XYZ 呼叫频率上的友台。',
    expected: 'BG5XYZ',
    evidenceTurns: [],
    featureMatches: [
      {
        callsign: 'BG5XYZ',
        confidence: 'high',
      },
    ],
    expectedSources: [
      'featureMatch',
      'featureMatch',
    ],
  },
  {
    id: 'high-unrelated-history',
    category: 'high-unrelated-history',
    transcript: '我用的是手台，五瓦发射功率。',
    expected: null,
    evidenceTurns: [
      {
        id: 'other-speaker',
        text: 'ABC，你用的是什么设备？',
      },
    ],
    featureMatches: [
      {
        callsign: 'BG5XYZ',
        confidence: 'high',
      },
    ],
  },
  {
    id: 'high-device-model',
    category: 'high-device-model',
    transcript: '我用的是手台，五瓦发射功率。',
    expected: null,
    evidenceTurns: [
      {
        id: 'other-speaker',
        text: '我的设备型号是 IC-XYZ。',
      },
    ],
    featureMatches: [
      {
        callsign: 'BG5XYZ',
        confidence: 'high',
      },
    ],
  },
  {
    id: 'high-embedded-call',
    category: 'high-embedded-call',
    transcript: '我用的是手台，五瓦发射功率。',
    expected: null,
    evidenceTurns: [
      {
        id: 'other-speaker',
        text: 'BG6XYZ，你用的是什么设备？',
      },
    ],
    featureMatches: [
      {
        callsign: 'BG5XYZ',
        confidence: 'high',
      },
    ],
  },
  {
    id: 'high-shorter-tail',
    category: 'high-shorter-tail',
    transcript: '我用的是手台，五瓦发射功率。',
    expected: null,
    evidenceTurns: [
      {
        id: 'other-speaker',
        text: 'YZ，你用的是什么设备？',
      },
    ],
    featureMatches: [
      {
        callsign: 'BG5XYZ',
        confidence: 'high',
      },
    ],
  },
  {
    id: 'medium-history-suffix',
    category: 'medium-history-suffix',
    transcript: '我用的是手台，五瓦发射功率。',
    expected: null,
    evidenceTurns: [
      {
        id: 'other-speaker',
        text: 'XYZ，你用的是什么设备？',
      },
    ],
    featureMatches: [
      {
        callsign: 'BG5XYZ',
        confidence: 'medium',
      },
    ],
  },
  {
    id: 'high-explicit-self-no-spelling',
    category: 'high-explicit-self-no-spelling',
    transcript: '这里是 BG5XYZ，收到。',
    expected: 'BG5XYZ',
    evidenceTurns: [],
    featureMatches: [
      {
        callsign: 'BG5XYZ',
        confidence: 'high',
      },
    ],
    expectedSources: [
      'text',
      'featureMatch',
    ],
  },
  {
    id: 'high-history-third-party',
    category: 'high-history-third-party',
    transcript: '我使用五瓦功率。',
    expected: null,
    evidenceTurns: [
      {
        id: 'other-speaker',
        text: '我刚才和 BG5XYZ 通联过，他已经关机离开了。',
      },
    ],
    featureMatches: [
      {
        callsign: 'BG5XYZ',
        confidence: 'high',
      },
    ],
  },
  {
    id: 'cq-station-call-quote',
    category: 'cq-station-call-quote',
    transcript: 'CQ CQ, Bravo Golf 5 Golf X-ray Tango, Bravo Germany 5 Germany X-ray Tango, BG5GXT 呼叫频率上的友台， Over。',
    expected: 'BG5GXT',
    evidenceTurns: [],
    featureMatches: [
      {
        callsign: 'BG5GXT',
        confidence: 'high',
      },
    ],
    expectedSources: [
      'text',
      'spelling',
    ],
  },
  {
    id: 'near-conflict-correct',
    category: 'near-conflict-correct',
    transcript: 'BG5EBE，这里是BG5BUD，Bravo杠Five，Bravo Uniform Tango，抄你信号五九。',
    expected: 'BG5BUT',
    evidenceTurns: [],
    featureMatches: [
      {
        callsign: 'BG5BUT',
        confidence: 'medium',
      },
    ],
    expectedSources: [
      'featureMatch',
      'spelling',
    ],
  },
  {
    id: 'near-conflict-wrong',
    category: 'near-conflict-wrong',
    transcript: 'BG5EBE，这里是BG5BUD，Bravo杠Five，Bravo Uniform Tango，抄你信号五九。',
    expected: null,
    evidenceTurns: [],
    featureMatches: [
      {
        callsign: 'BG5BUV',
        confidence: 'high',
      },
    ],
  },
]
