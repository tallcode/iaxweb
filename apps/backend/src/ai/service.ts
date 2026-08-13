import type { AiConfig } from '../config.js'
import type { AudioStateEvent } from '../nats-audio.js'
import type { SegmentRecord } from './segment-store.js'
import type { ClosedSegment, DiscardReason } from './segmenter.js'
import type { SpotEvent } from './spot-store.js'
import { randomUUID } from 'node:crypto'
import { AsrClient } from './asr-client.js'
import { AsrContextFiles, logTimestamp } from './asr-context-files.js'
import { LlmParser } from './llm-parser.js'
import { decodeMuLaw } from './mulaw.js'
import { correctExplanationText } from './phonetic-corrector.js'
import { SerialQueue } from './queue.js'
import { RecordingStore } from './recording-store.js'
import { SegmentRepository } from './segment-repository.js'
import { SegmentStore } from './segment-store.js'
import { NodeSegmenter } from './segmenter.js'
import { encodeWav } from './wav.js'

const MAX_QUEUE_DEPTH = 10

interface NodeAiRuntime {
  queue: SerialQueue
  segmenter: NodeSegmenter
  store: SegmentStore
}

export interface AiServiceOptions {
  config: AiConfig
  nodeIds: string[]
  onSpot?: (spot: SpotEvent) => void
  repository?: SegmentRepository
}

// AI 值机员：监听节点音频，按发射分段送百炼识别，输出到控制台。
// 独立于网关其余功能：未启用的节点不会进入这里，模块内部错误只记录不外抛。
export class AiService {
  private readonly config: AiConfig
  private readonly asrContextFiles: AsrContextFiles
  private readonly asr: AsrClient
  private readonly llm: LlmParser | undefined
  private readonly onSpot: ((spot: SpotEvent) => void) | undefined
  private readonly repository: SegmentRepository | undefined
  private readonly recordings: RecordingStore | undefined
  private readonly nodes = new Map<string, NodeAiRuntime>()
  private stopped = false

  constructor(options: AiServiceOptions) {
    const { config, nodeIds } = options
    this.config = config
    this.asrContextFiles = new AsrContextFiles(config.hotwordsFile, config.backgroundFile)
    this.repository = options.repository ?? (config.persistenceEnabled ? new SegmentRepository(config.databaseFile) : undefined)
    this.recordings = config.persistenceEnabled ? new RecordingStore(config.recordingsDirectory) : undefined
    this.onSpot = options.onSpot
    this.asr = new AsrClient({
      apiKey: config.apiKey ?? '',
      baseUrl: config.baseUrl,
      model: config.model,
    })
    this.llm = config.llmEnabled
      ? new LlmParser({
          apiKey: config.apiKey ?? '',
          baseUrl: config.baseUrl,
          ...(config.callsignHintsEnabled
            ? { callsignHintsEnabled: true, callsignsFile: config.callsignsFile }
            : {}),
          ...(config.llmEnableThinking ? { enableThinking: true } : {}),
          model: config.llmModel,
          promptFile: config.llmPromptFile,
          schemaFile: config.llmSchemaFile,
          ...(config.llmThinkingBudget !== undefined ? { thinkingBudget: config.llmThinkingBudget } : {}),
          timeoutMs: config.llmTimeoutMs,
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

    let event: { duration_ms?: unknown, type?: unknown }
    try {
      event = JSON.parse(text)
    }
    catch {
      return
    }

    try {
      if (event.type === 'start') {
        runtime.segmenter.start()
      }
      else if (event.type === 'stop') {
        const durationMs = typeof event.duration_ms === 'number' ? event.duration_ms : undefined
        runtime.segmenter.stop(durationMs)
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
    for (const runtime of this.nodes.values())
      runtime.queue.clear()
    this.repository?.close()
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
    }
    const shortId = record.id.slice(0, 8)
    const wav = encodeWav(decodeMuLaw(concatenate(segment.payloads)))
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
      }
      runtime.store.add(record)
      if (text) {
        if (this.repository && this.recordings) {
          try {
            this.repository.insert(nodeId, record)
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
        await this.parseTranscript(nodeId, runtime, record, text)
      }
    }
    catch (error) {
      console.warn(`${logTimestamp()} [${nodeId}]: ASR 失败 ${shortId}: ${errorMessage(error)}`)
    }
  }

  // LLM 解析：将识别文本交给对话模型，完整版输出规范化文本、发言人呼号与
  // 风控，简化版只输出呼号。最近解析过的轮次作为上下文传入以保持连续性。
  // 解析结果打印为主日志行；解析失败时降级打印原始识别文本。
  private async parseTranscript(nodeId: string, runtime: NodeAiRuntime, record: SegmentRecord, text: string): Promise<void> {
    const shortId = record.id.slice(0, 8)
    const seconds = (record.durationMs / 1000).toFixed(1)
    // 未启用 LLM 解析时，原始识别文本是唯一的输出。
    if (!this.llm) {
      console.log(`${logTimestamp()} [${nodeId}]: ${shortId} ${seconds}s | ${text}`)
      return
    }
    try {
      const parsed = await this.llm.parse(text, runtime.store.llmHistory(undefined, record.id), record.corrected ?? text)
      // 解析返回 undefined 说明提示词/schema 文件缺失：LLM 解析未生效。
      if (this.stopped)
        return
      if (!parsed) {
        console.warn(`${logTimestamp()} [${nodeId}]: LLM 未生效 ${shortId}：提示词或 schema 文件缺失`)
        console.log(`${logTimestamp()} [${nodeId}]: ${shortId} ${seconds}s | ${text}`)
        return
      }
      record.revise = parsed.message
      record.callsign = parsed.Callsign
      record.risk = parsed.risk
      if (this.repository) {
        try {
          if (!this.repository.updateAnalysis(record))
            console.warn(`${logTimestamp()} [${nodeId}]: SQLite 更新失败 ${shortId}: 记录不存在`)
        }
        catch (error) {
          console.warn(`${logTimestamp()} [${nodeId}]: SQLite 更新失败 ${shortId}: ${errorMessage(error)}`)
        }
      }
      console.log(`${logTimestamp()} [${nodeId}]: ${shortId} ${seconds}s${parsed.Callsign ? ` 呼号=${parsed.Callsign}` : ''} | ${parsed.message ?? text}`)
      if (parsed.Callsign && this.config.llmPublishSpot) {
        this.onSpot?.({
          at: record.timestamp,
          callsign: parsed.Callsign,
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
