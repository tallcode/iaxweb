import type { RadioSignal, SpeakerMatch } from '@iaxweb/contracts'
import type { AiConfig } from '../config.js'
import type { RecognitionRepository } from '../records/ports.js'
import type { ReadyVoiceprint } from '../records/types.js'
import type { SpotEvent } from '../spots/spot-store.js'
import type { SegmentRecord, SegmentStore } from './segment-store.js'
import type { ClosedSegment } from './segmenter.js'
import type { SpeakerReferenceService } from './speaker-references.js'
import { randomUUID } from 'node:crypto'
import { AUDIO_QUALITY_GATE_VERSION } from '@iaxweb/contracts'
import { saveRecognizedRecording } from '../records/recognition-persistence.js'
import { RecordingStore } from '../records/recording-store.js'
import { SignalingService } from '../signaling/service.js'
import { AsrClient } from './asr-client.js'
import { AsrContextFiles, logTimestamp } from './asr-context-files.js'
import { AudioQualityService } from './audio-quality.js'
import { correctExplanationText } from './corrected-transcript.js'
import { LlmParser } from './llm-parser.js'
import { decodeMuLaw } from './mulaw.js'
import { encodeWav } from './wav.js'

const LIVE_SPEAKER_TIMEOUT_MS = 20_000

export interface SegmentRecognitionOptions {
  config: AiConfig
  onSpot?: (spot: SpotEvent) => void
  repository?: RecognitionRepository
  speakerReferences?: Pick<SpeakerReferenceService, 'startLiveRecognition' | 'cacheQueryVoiceprint'>
  audioQuality?: AudioQualityService
}

// Processes closed segments. The caller serializes work per node so that each
// request receives the context accumulated by the previous segment.
export class SegmentRecognition {
  private readonly config: AiConfig
  private readonly asrContextFiles: AsrContextFiles
  private readonly asr: AsrClient
  private readonly llm: LlmParser | undefined
  private readonly onSpot: ((spot: SpotEvent) => void) | undefined
  private readonly repository: RecognitionRepository | undefined
  private readonly recordings: RecordingStore | undefined
  private readonly signaling: SignalingService | undefined
  private readonly speakerReferences: SegmentRecognitionOptions['speakerReferences']
  private readonly audioQuality: AudioQualityService
  private readonly ownsAudioQuality: boolean
  private readonly abort = new AbortController()

  constructor(options: SegmentRecognitionOptions) {
    const { config } = options
    this.config = config
    this.asrContextFiles = new AsrContextFiles(config.hotwordsFile, config.backgroundFile)
    if (config.persistenceEnabled && !options.repository)
      throw new Error('AI persistence requires an injected recognition repository')
    this.repository = options.repository
    this.audioQuality = options.audioQuality ?? new AudioQualityService()
    this.ownsAudioQuality = !options.audioQuality
    this.signaling = options.repository?.updateSignaling || config.llm.enabled ? new SignalingService() : undefined
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
  }

  stop(): void {
    this.abort.abort()
    this.signaling?.stop()
    if (this.ownsAudioQuality)
      this.audioQuality.stop()
  }

  async process(nodeId: string, store: SegmentStore, segment: ClosedSegment): Promise<void> {
    const record: SegmentRecord = {
      durationMs: segment.durationMs,
      id: randomUUID(),
      payloads: segment.payloads,
      sourceRepeaterId: segment.sourceRepeaterId ?? null,
      timestamp: segment.capturedAt,
      voicedMs: segment.voicedMs,
      transmissionId: segment.transmissionId,
      partIndex: segment.partIndex,
    }
    const shortId = record.id.slice(0, 8)
    const pcm = decodeMuLaw(concatenate(segment.payloads))
    const wav = encodeWav(pcm)
    const signaling = this.signaling?.decode(pcm)
    const signalingEvidence = this.llm && signaling
      ? optionalEvidence(signaling, null, AbortSignal.any([this.abort.signal, AbortSignal.timeout(LIVE_SPEAKER_TIMEOUT_MS)]))
      : undefined
    const speakerReferences = this.speakerReferences
    const liveAbort = speakerReferences && new AbortController()
    let live: ReturnType<SpeakerReferenceService['startLiveRecognition']> | undefined
    let featureMatches: Promise<SpeakerMatch[]> | undefined
    try {
      const text = (await this.asr.transcribe(wav, {
        background: this.asrContextFiles.readBackground(),
        hotwords: this.asrContextFiles.readHotwords(),
        previous: store.asrContext(),
      })).trim()

      if (this.abort.signal.aborted)
        return
      if (text) {
        record.recognition = text
        record.corrected = correctExplanationText(text).text
        record.audioQuality = await this.audioQuality.check(Float32Array.from(pcm, sample => sample / 32768), this.abort.signal, AUDIO_QUALITY_GATE_VERSION)
        if (this.abort.signal.aborted)
          return
        if (record.audioQuality.status === 'passed' && speakerReferences && liveAbort) {
          try {
            const signal = AbortSignal.any([this.abort.signal, liveAbort.signal, AbortSignal.timeout(LIVE_SPEAKER_TIMEOUT_MS)])
            live = speakerReferences.startLiveRecognition(record.id, pcm, record.voicedMs, signal, true)
            featureMatches = optionalEvidence(live.matches, [], signal)
          }
          catch (error) {
            console.warn(`${logTimestamp()} [${nodeId}]: 自动特征提取启动失败 ${shortId}: ${errorMessage(error)}`)
          }
        }
      }
      store.add(record)
      if (text) {
        const persisted = this.persist(nodeId, record, wav, signaling, live?.voiceprint)
        if (record.audioQuality?.status === 'passed')
          await this.recognizeCallsign(nodeId, store, record, text, persisted, featureMatches, signalingEvidence)
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

  // 一次 LLM 提取后，由代码按证据来源判断；特征和尾音不进入 LLM。
  private async recognizeCallsign(
    nodeId: string,
    store: SegmentStore,
    record: SegmentRecord,
    text: string,
    persisted: boolean,
    featureMatches?: Promise<SpeakerMatch[]>,
    signaling?: Promise<readonly RadioSignal[] | null>,
  ): Promise<void> {
    const shortId = record.id.slice(0, 8)
    const seconds = (record.durationMs / 1000).toFixed(1)
    // 未启用 LLM 解析时，原始识别文本是唯一的输出。
    if (!this.llm) {
      console.log(`${logTimestamp()} [${nodeId}]: ${shortId} ${seconds}s | ${text}`)
      return
    }
    try {
      const history = store.llmTurns(undefined, record.id)
      const metadata = {
        id: record.id,
        transmissionId: record.transmissionId,
        partIndex: record.partIndex,
      }
      const parsed = await this.llm.parse(text, history, metadata)
      // 配置不可用时，保留此前已写入的转写记录。
      if (this.abort.signal.aborted)
        return
      if (!parsed) {
        console.warn(`${logTimestamp()} [${nodeId}]: LLM 未生效 ${shortId}：提示词或 schema 不可用`)
        console.log(`${logTimestamp()} [${nodeId}]: ${shortId} ${seconds}s | ${text}`)
        return
      }
      record.callsign = parsed.callsign
      record.callsignAlgorithm = parsed.algorithm
      if (!record.callsign && parsed.prepared) {
        // Resolve both sources together: an earlier feature source must not be
        // bypassed merely because the lower-priority tail finishes first.
        const [matches, signals] = await Promise.all([
          featureMatches ?? Promise.resolve([]),
          signaling ?? Promise.resolve(null),
        ])
        if (!this.abort.signal.aborted) {
          const resolved = this.llm.resolve(parsed, matches, signals ?? [])
          record.callsign = resolved?.callsign
          record.callsignAlgorithm = resolved?.algorithm
        }
      }
      if (this.abort.signal.aborted)
        return
      if (this.repository && persisted && record.callsign) {
        try {
          if (!this.repository.updateAutomaticCallsign(record))
            console.warn(`${logTimestamp()} [${nodeId}]: 呼号保存失败 ${shortId}: 记录不存在`)
        }
        catch (error) {
          console.warn(`${logTimestamp()} [${nodeId}]: 呼号保存失败 ${shortId}: ${errorMessage(error)}`)
        }
      }
      console.log(`${logTimestamp()} [${nodeId}]: ${shortId} ${seconds}s${record.callsign ? ` 呼号=${record.callsign}` : ''} | ${text}`)
      if (record.callsign && this.config.llm.publishSpot && this.mayPublish(record.id, persisted)) {
        this.onSpot?.({
          at: record.timestamp,
          callsign: record.callsign,
          id: record.id,
          node: nodeId,
        })
      }
    }
    catch (error) {
      console.warn(`${logTimestamp()} [${nodeId}]: LLM 解析失败 ${shortId}: ${errorMessage(error)}`)
      console.log(`${logTimestamp()} [${nodeId}]: ${shortId} ${seconds}s | ${text}`)
    }
  }

  private persist(
    nodeId: string,
    record: SegmentRecord,
    wav: Uint8Array,
    signaling: ReturnType<SignalingService['decode']> | undefined,
    voiceprint: Promise<ReadyVoiceprint | undefined> | undefined,
  ): boolean {
    const { repository, recordings } = this
    if (!repository || !recordings)
      return false
    const shortId = record.id.slice(0, 8)
    try {
      saveRecognizedRecording(repository, recordings, nodeId, record, wav)
    }
    catch (error) {
      console.warn(`${logTimestamp()} [${nodeId}]: 录音记录保存失败 ${shortId}: ${errorMessage(error)}`)
      return false
    }
    void signaling?.then((signals) => {
      if (signals === null || this.abort.signal.aborted)
        return
      try {
        repository.updateSignaling?.(record.id, signals)
      }
      catch (error) {
        console.warn(`${logTimestamp()} [${nodeId}]: 信令保存失败 ${shortId}: ${errorMessage(error)}`)
      }
    }).catch((error) => {
      console.warn(`${logTimestamp()} [${nodeId}]: 信令保存失败 ${shortId}: ${errorMessage(error)}`)
    })
    void voiceprint?.then((result) => {
      if (result && !this.abort.signal.aborted)
        this.speakerReferences?.cacheQueryVoiceprint(record.id, result)
    }).catch((error) => {
      console.warn(`${logTimestamp()} [${nodeId}]: 特征缓存失败 ${shortId}: ${errorMessage(error)}`)
    })
    return true
  }

  private mayPublish(id: string, persisted: boolean): boolean {
    return !this.repository || (persisted && this.repository.find(id)?.manualCallsign === null)
  }
}

// Supporting evidence may fail independently. Consume rejection immediately,
// and keep the AI queue responsive when a decoder or extractor is cancelled.
function optionalEvidence<T>(pending: Promise<T>, fallback: T, signal: AbortSignal): Promise<T> {
  return new Promise((resolve) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      resolve(fallback)
    }
    const finish = (value: T) => {
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }
    if (signal.aborted)
      finish(fallback)
    else
      signal.addEventListener('abort', onAbort, { once: true })
    void pending.then(finish, () => finish(fallback))
  })
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
