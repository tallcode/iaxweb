import type { SpeakerMatch } from '@iaxweb/contracts'
import type { AiConfig } from '../config.js'
import type { AudioStateEvent } from '../gateway/nats-audio.js'
import type { RecognitionRepository } from '../records/ports.js'
import type { SpotEvent } from '../spots/spot-store.js'
import type { SegmentRecord } from './segment-store.js'
import type { ClosedSegment, DiscardReason } from './segmenter.js'
import type { SpeakerReferenceService } from './speaker-references.js'
import { randomUUID } from 'node:crypto'
import { RecordingStore } from '../records/recording-store.js'
import { SignalingService } from '../signaling/service.js'
import { AsrClient } from './asr-client.js'
import { AsrContextFiles, logTimestamp } from './asr-context-files.js'
import { AudioQualityService } from './audio-quality.js'
import { correctExplanationText } from './corrected-transcript.js'
import { LlmParser } from './llm-parser.js'
import { decodeMuLaw } from './mulaw.js'
import { SerialQueue } from './queue.js'
import { SegmentStore } from './segment-store.js'
import { NodeSegmenter } from './segmenter.js'
import { encodeWav } from './wav.js'

const MAX_QUEUE_DEPTH = 10
const LIVE_SPEAKER_TIMEOUT_MS = 20_000

interface NodeAiRuntime {
  queue: SerialQueue
  segmenter: NodeSegmenter
  store: SegmentStore
}

export interface AiServiceOptions {
  config: AiConfig
  nodeIds: string[]
  onSpot?: (spot: SpotEvent) => void
  repository?: RecognitionRepository
  speakerReferences?: Pick<SpeakerReferenceService, 'startLiveRecognition' | 'cacheQueryVoiceprint'>
  audioQuality?: AudioQualityService
}

// AI 值机员：监听节点音频，按发射分段送百炼识别，输出到控制台。
// 独立于网关其余功能：未启用的节点不会进入这里，模块内部错误只记录不外抛。
export class AiService {
  private readonly config: AiConfig
  private readonly asrContextFiles: AsrContextFiles
  private readonly asr: AsrClient
  private readonly llm: LlmParser | undefined
  private readonly onSpot: ((spot: SpotEvent) => void) | undefined
  private readonly repository: RecognitionRepository | undefined
  private readonly recordings: RecordingStore | undefined
  private readonly signaling: SignalingService | undefined
  private readonly speakerReferences: AiServiceOptions['speakerReferences']
  private readonly audioQuality: AudioQualityService
  private readonly ownsAudioQuality: boolean
  private readonly abort = new AbortController()
  private readonly nodes = new Map<string, NodeAiRuntime>()
  private stopped = false

  constructor(options: AiServiceOptions) {
    const { config, nodeIds } = options
    this.config = config
    this.asrContextFiles = new AsrContextFiles(config.hotwordsFile, config.backgroundFile)
    if (config.persistenceEnabled && !options.repository)
      throw new Error('AI persistence requires an injected recognition repository')
    this.repository = options.repository
    this.audioQuality = options.audioQuality ?? new AudioQualityService()
    this.ownsAudioQuality = !options.audioQuality
    this.signaling = options.repository?.updateSignaling ? new SignalingService() : undefined
    this.recordings = config.persistenceEnabled ? new RecordingStore(config.recordingsDirectory) : undefined
    this.speakerReferences = config.llm.stage2Enabled && config.llm.enabled && this.recordings ? options.speakerReferences : undefined
    this.onSpot = options.onSpot
    this.asr = new AsrClient({
      apiKey: config.asr.apiKey ?? '',
      baseUrl: config.asr.baseUrl,
      model: config.asr.model,
    })
    this.llm = config.llm.enabled
      ? new LlmParser({
          analysisEnabled: config.llm.analysisEnabled,
          apiKey: config.llm.apiKey ?? '',
          baseUrl: config.llm.baseUrl,
          ...(config.llm.enableThinking !== undefined ? { enableThinking: config.llm.enableThinking } : {}),
          model: config.llm.model,
          promptFile: config.llm.promptFile,
          schemaFile: config.llm.schemaFile,
          ...(config.llm.thinkingBudget !== undefined ? { thinkingBudget: config.llm.thinkingBudget } : {}),
          timeoutMs: config.llm.timeoutMs,
        })
      : undefined

    for (const nodeId of nodeIds) {
      this.nodes.set(nodeId, {
        queue: new SerialQueue(MAX_QUEUE_DEPTH, () => {
          console.warn(`${logTimestamp()} [${nodeId}]: AI 任务积压，丢弃最旧任务`)
        }),
        segmenter: new NodeSegmenter({
          activityWindowMs: config.activityWindowMs,
          coldMinMs: config.coldMinSegmentMs,
          hotMinMs: config.hotMinSegmentMs,
          maxMs: config.maxSegmentMs,
          onDiscard: (reason, durationMs, minMs) => this.logDiscard(nodeId, reason, durationMs, minMs),
          onSegment: segment => this.enqueue(nodeId, segment),
        }),
        store: new SegmentStore(config.contextWindowMs),
      })
    }
    console.log(`${logTimestamp()} [AI]: 值机员已启用，节点: ${nodeIds.join(', ')}`)
  }

  hasNode(nodeId: string): boolean {
    return this.nodes.has(nodeId)
  }

  // Recent segment records of a node, for unified management and downstream
  // consumers (log search, future UI/NATS export, tests).
  segments(nodeId: string): SegmentRecord[] {
    return this.nodes.get(nodeId)?.store.recent() ?? []
  }

  pushFrame(nodeId: string, data: Uint8Array): void {
    if (this.stopped)
      return
    try {
      this.nodes.get(nodeId)?.segmenter.pushFrame(data)
    }
    catch (error) {
      // Must never throw into the audio relay loop.
      console.warn(`${logTimestamp()} [${nodeId}]: AI 帧处理异常: ${errorMessage(error)}`)
    }
  }

  // Transmission boundaries arrive as `start`/`stop` events on the node's
  // events subject; iaxmon does not republish state events for speaking
  // changes (see iaxmon NATS.md).
  onEvent(nodeId: string, text: string): void {
    if (this.stopped)
      return
    const runtime = this.nodes.get(nodeId)
    if (!runtime)
      return

    let event: { duration_ms?: unknown, timestamp?: unknown, type?: unknown }
    try {
      event = JSON.parse(text)
    }
    catch {
      return
    }

    try {
      const timestamp = typeof event.timestamp === 'number' && Number.isInteger(event.timestamp)
        && event.timestamp >= 0 && event.timestamp <= 0xFFFF_FFFF
        ? event.timestamp
        : undefined
      if (event.type === 'start') {
        runtime.segmenter.start(timestamp)
      }
      else if (event.type === 'stop') {
        const durationMs = typeof event.duration_ms === 'number' && Number.isFinite(event.duration_ms)
          && event.duration_ms >= 0
          ? event.duration_ms
          : undefined
        runtime.segmenter.stop(durationMs, timestamp)
      }
    }
    catch (error) {
      console.warn(`${logTimestamp()} [${nodeId}]: AI 事件处理异常: ${errorMessage(error)}`)
    }
  }

  onState(nodeId: string, state: AudioStateEvent): void {
    if (this.stopped)
      return
    try {
      const runtime = this.nodes.get(nodeId)
      if (!runtime)
        return
      if (!state.online) {
        runtime.segmenter.reset()
        return
      }
      runtime.segmenter.setSpeaking(state.speaking)
    }
    catch (error) {
      console.warn(`${logTimestamp()} [${nodeId}]: AI 状态处理异常: ${errorMessage(error)}`)
    }
  }

  stop(): void {
    if (this.stopped)
      return
    this.stopped = true
    this.abort.abort()
    this.signaling?.stop()
    if (this.ownsAudioQuality)
      this.audioQuality.stop()
    for (const runtime of this.nodes.values())
      runtime.queue.clear()
  }

  private enqueue(nodeId: string, segment: ClosedSegment): void {
    const runtime = this.nodes.get(nodeId)
    if (!runtime || this.stopped)
      return
    runtime.queue.add(() => this.transcribe(nodeId, runtime, segment))
  }

  private async transcribe(nodeId: string, runtime: NodeAiRuntime, segment: ClosedSegment): Promise<void> {
    const record: SegmentRecord = {
      durationMs: segment.durationMs,
      id: randomUUID(),
      payloads: segment.payloads,
      timestamp: new Date().toISOString(),
      voicedMs: segment.voicedMs,
      transmissionId: segment.transmissionId,
      partIndex: segment.partIndex,
    }
    const shortId = record.id.slice(0, 8)
    const pcm = decodeMuLaw(concatenate(segment.payloads))
    const wav = encodeWav(pcm)
    const signaling = this.signaling?.decode(pcm)
    const speakerReferences = this.speakerReferences
    const liveAbort = speakerReferences && new AbortController()
    let live: ReturnType<SpeakerReferenceService['startLiveRecognition']> | undefined
    try {
      const text = (await this.asr.transcribe(wav, {
        background: this.asrContextFiles.readBackground(),
        hotwords: this.asrContextFiles.readHotwords(),
        previous: runtime.store.asrContext(),
      })).trim()

      if (this.stopped)
        return
      if (text) {
        record.recognition = text
        record.corrected = correctExplanationText(text).text
        record.audioQuality = await this.audioQuality.check(Float32Array.from(pcm, sample => sample / 32768), this.abort.signal)
        if (this.stopped)
          return
        if (record.audioQuality.status === 'passed' && speakerReferences && liveAbort) {
          try {
            const signal = AbortSignal.any([this.abort.signal, liveAbort.signal, AbortSignal.timeout(LIVE_SPEAKER_TIMEOUT_MS)])
            live = speakerReferences.startLiveRecognition(record.id, pcm, record.voicedMs, signal, true)
          }
          catch (error) {
            console.warn(`${logTimestamp()} [${nodeId}]: 自动特征提取启动失败 ${shortId}: ${errorMessage(error)}`)
          }
        }
      }
      runtime.store.add(record)
      if (text) {
        if (this.repository && this.recordings) {
          try {
            this.repository.insert(nodeId, record)
            void signaling?.then((signals) => {
              if (signals === null || this.stopped)
                return
              try {
                this.repository?.updateSignaling?.(record.id, signals)
              }
              catch (error) {
                console.warn(`${logTimestamp()} [${nodeId}]: 信令保存失败 ${shortId}: ${errorMessage(error)}`)
              }
            })
            void live?.voiceprint.then((voiceprint) => {
              if (voiceprint && !this.stopped)
                speakerReferences?.cacheQueryVoiceprint(record.id, voiceprint)
            })
          }
          catch (error) {
            console.warn(`${logTimestamp()} [${nodeId}]: SQLite 写入失败 ${shortId}: ${errorMessage(error)}`)
          }
          try {
            this.recordings.save(record.id, record.timestamp, wav)
          }
          catch (error) {
            console.warn(`${logTimestamp()} [${nodeId}]: 录音保存失败 ${shortId}: ${errorMessage(error)}`)
          }
        }
        if (record.audioQuality?.status === 'passed')
          await this.parseTranscript(nodeId, runtime, record, text, live?.matches)
        else
          console.log(`${logTimestamp()} [${nodeId}]: ${shortId} ${(record.durationMs / 1000).toFixed(1)}s | ${text}`)
      }
    }
    catch (error) {
      console.warn(`${logTimestamp()} [${nodeId}]: ASR 失败 ${shortId}: ${errorMessage(error)}`)
    }
    finally {
      if (!record.recognition)
        liveAbort?.abort()
    }
  }

  // LLM 解析：将识别文本交给对话模型，完整版输出规范化文本、发言人呼号与
  // 风控，简化版只输出呼号。最近解析过的轮次作为上下文传入以保持连续性。
  // 解析结果打印为主日志行；解析失败时降级打印原始识别文本。
  private async parseTranscript(nodeId: string, runtime: NodeAiRuntime, record: SegmentRecord, text: string, featureMatches?: Promise<SpeakerMatch[]>): Promise<void> {
    const shortId = record.id.slice(0, 8)
    const seconds = (record.durationMs / 1000).toFixed(1)
    // 未启用 LLM 解析时，原始识别文本是唯一的输出。
    if (!this.llm) {
      console.log(`${logTimestamp()} [${nodeId}]: ${shortId} ${seconds}s | ${text}`)
      return
    }
    try {
      const history = runtime.store.llmTurns(undefined, record.id)
      const corrected = record.corrected ?? text
      const metadata = {
        id: record.id,
        transmissionId: record.transmissionId,
        partIndex: record.partIndex,
      }
      const parsed = await this.llm.parse(text, history, corrected, metadata)
      // 配置不可用时，保留此前已写入的转写记录。
      if (this.stopped)
        return
      if (!parsed) {
        console.warn(`${logTimestamp()} [${nodeId}]: LLM 未生效 ${shortId}：提示词或 schema 不可用`)
        console.log(`${logTimestamp()} [${nodeId}]: ${shortId} ${seconds}s | ${text}`)
        return
      }
      record.revise = parsed.message
      record.callsign = parsed.callsign
      record.risk = parsed.risk
      if (record.callsign) {
        record.callsignAlgorithm = 'stage1_text'
      }
      else if (parsed.extraction && featureMatches) {
        try {
          const matches = await featureMatches
          if (!this.stopped && matches.length > 0) {
            record.callsign = this.llm.parseStage2(parsed, matches)
            if (record.callsign)
              record.callsignAlgorithm = 'stage2_feature'
          }
        }
        catch (error) {
          console.warn(`${logTimestamp()} [${nodeId}]: 第二阶段呼号识别失败 ${shortId}: ${errorMessage(error)}`)
        }
      }
      if (this.stopped)
        return
      if (this.repository) {
        try {
          if (!this.repository.updateAnalysis(record))
            console.warn(`${logTimestamp()} [${nodeId}]: SQLite 更新失败 ${shortId}: 记录不存在`)
        }
        catch (error) {
          console.warn(`${logTimestamp()} [${nodeId}]: SQLite 更新失败 ${shortId}: ${errorMessage(error)}`)
        }
      }
      console.log(`${logTimestamp()} [${nodeId}]: ${shortId} ${seconds}s${record.callsign ? ` 呼号=${record.callsign}` : ''} | ${parsed.message ?? text}`)
      const persisted = this.repository?.find(record.id)
      const mayPublish = !this.repository || (persisted !== undefined && persisted.manualCallsign === null)
      if (record.callsign && this.config.llm.publishSpot && mayPublish) {
        this.onSpot?.({
          at: record.timestamp,
          callsign: record.callsign,
          id: record.id,
          node: nodeId,
        })
      }
      const risk = parsed.risk
      if (risk && risk.level >= 3)
        console.warn(`${logTimestamp()} [${nodeId}]: 风控告警 ${shortId} L${risk.level}: ${risk.reason}`)
    }
    catch (error) {
      console.warn(`${logTimestamp()} [${nodeId}]: LLM 解析失败 ${shortId}: ${errorMessage(error)}`)
      console.log(`${logTimestamp()} [${nodeId}]: ${shortId} ${seconds}s | ${text}`)
    }
  }

  private logDiscard(nodeId: string, reason: DiscardReason, durationMs: number, _minMs?: number): void {
    const seconds = (durationMs / 1000).toFixed(1)
    if (reason === 'short') {
      console.log(`${logTimestamp()} [${nodeId}]: 丢弃段 ${seconds}s`)
    }
    else if (reason === 'offline') {
      console.log(`${logTimestamp()} [${nodeId}]: 节点离线，丢弃未完成段 ${seconds}s`)
    }
    else {
      console.log(`${logTimestamp()} [${nodeId}]: 音频流重置，丢弃未完成段 ${seconds}s`)
    }
  }
}

function concatenate(payloads: Uint8Array[]): Uint8Array {
  let total = 0
  for (const payload of payloads)
    total += payload.length
  const combined = new Uint8Array(total)
  let offset = 0
  for (const payload of payloads) {
    combined.set(payload, offset)
    offset += payload.length
  }
  return combined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
