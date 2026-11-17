import type { SpeakerRecognition } from '@iaxweb/contracts'
import type { SpeakerReferenceRepository } from '../records/ports.js'
import type { Voiceprint } from '../records/types.js'
import { SPEAKER_REFERENCE_THRESHOLD } from '../records/record-repository.js'
import { logTimestamp } from './asr-context-files.js'
import { SPEAKER_VERSION } from './speaker-model.mjs'
import { readSpeakerWav, speakerWavFile } from './speaker-wav.js'
import { SpeakerExtractor } from './speaker.js'

interface SpeakerReferenceOptions {
  repository: SpeakerReferenceRepository
  recordingsDirectory: string
  modelFile: string
}

// One resident extractor for manual queries and reviewed-reference jobs.
// The DB's reviewed flag is checked again on every read and final write.
export class SpeakerReferenceService {
  private readonly extractor: SpeakerExtractor
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly abort = new AbortController()
  private stopped = false
  private running = false

  constructor(private readonly options: SpeakerReferenceOptions) {
    this.extractor = new SpeakerExtractor(options.modelFile)
  }

  start(): void {
    if (this.timer || this.stopped)
      return
    this.schedule(0)
  }

  stop(): void {
    this.stopped = true
    clearTimeout(this.timer)
    this.abort.abort()
    this.extractor.stop()
  }

  async recognizeRecord(recordId: string): Promise<SpeakerRecognition> {
    const unavailable = (reasonCode: NonNullable<SpeakerRecognition['reasonCode']>, reason: string): SpeakerRecognition => ({
      recordId,
      threshold: SPEAKER_REFERENCE_THRESHOLD,
      status: 'unavailable',
      reasonCode,
      reason,
      referenceCount: null,
      matches: [],
    })
    const record = this.options.repository.find(recordId)
    if (!record)
      return unavailable('record_missing', '记录已不存在，请刷新列表。')
    if (this.stopped)
      return unavailable('extraction_failed', '声纹服务正在停止，请稍后重试。')
    let samples: Float32Array
    try {
      samples = await readSpeakerWav(speakerWavFile(this.options.recordingsDirectory, { id: record.id, timestamp: record.capturedAt }), this.abort.signal)
    }
    catch (error) {
      const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT'
      return missing
        ? unavailable('recording_missing', '录音文件不存在或已过期，无法进行声纹识别。')
        : unavailable('recording_invalid', '录音文件无法读取或格式无效，无法进行声纹识别。')
    }
    let voiceprint: Voiceprint
    try {
      voiceprint = await this.extractor.extract(samples, record.voicedMs)
    }
    catch (error) {
      const detail = String(error)
      if (detail.includes('timed out'))
        return unavailable('extraction_timeout', '声纹提取超时，请稍后重试。')
      if (detail.includes('queue full'))
        return unavailable('extraction_busy', '声纹任务较多，请稍后重试。')
      if (!this.stopped)
        console.warn(`${logTimestamp()} [AI]: 手动声纹提取失败: ${detail}`)
      return unavailable('extraction_failed', '声纹模型暂不可用或提取失败，请稍后重试。')
    }
    if (voiceprint.status !== 'ready') {
      switch (voiceprint.reason) {
        case 'interference_tone': return unavailable('interference_tone', '检测到明显窄带干扰，未生成查询声纹。')
        case 'interference_high_band': return unavailable('interference_high_band', '检测到高频能量异常，可能存在弱干扰，未生成查询声纹。')
        case 'invalid_audio': return unavailable('invalid_audio', '音频采样无效，未生成查询声纹。')
        default: return unavailable('insufficient_audio', '有效音频不足 1 秒或没有可用信号，未生成查询声纹。')
      }
    }
    // Read-only even for a reviewed source: never prepare/update its embedding.
    // The current recording is always excluded from its own reference results.
    try {
      const { referenceCount, matches } = this.options.repository.searchSpeakerMatches(voiceprint, recordId)
      return {
        recordId,
        threshold: SPEAKER_REFERENCE_THRESHOLD,
        status: matches.length > 0 ? 'matched' : 'no_match',
        reasonCode: matches.length > 0 ? null : referenceCount === 0 ? 'empty_reference_library' : 'below_threshold',
        reason: matches.length > 0
          ? null
          : referenceCount === 0
            ? '参考库中暂无其他已标注、质量合格且有有效主叫呼号的同版本声纹。'
            : '没有找到相似度大于 0.80 的已标注录音。',
        referenceCount,
        matches,
      }
    }
    catch (error) {
      console.warn(`${logTimestamp()} [AI]: 手动声纹检索失败: ${String(error)}`)
      return unavailable('search_failed', '声纹检索失败，请稍后重试。')
    }
  }

  // Bounded batches keep live queries from waiting behind a historical corpus.
  // Missing/pending reviewed rows form a durable queue, including after restart.
  async processPending(): Promise<void> {
    if (this.stopped || this.running || this.extractor.backingOff)
      return
    this.running = true
    const { repository, recordingsDirectory } = this.options
    try {
      for (const record of repository.pendingReviewedVoiceprints()) {
        if (this.stopped)
          break
        if (!repository.prepareReviewedVoiceprint(record.id))
          continue
        try {
          const samples = await readSpeakerWav(speakerWavFile(recordingsDirectory, record), this.abort.signal)
          if (this.stopped)
            break
          if (!repository.find(record.id)?.reviewed)
            continue
          const voiceprint = await this.extractor.extract(samples, record.voicedMs)
          if (this.stopped)
            break
          repository.updateVoiceprint(record.id, voiceprint)
        }
        catch (error) {
          if (this.stopped)
            break
          const detail = String(error)
          if ((this.extractor.backingOff && !detail.includes('timed out')) || detail.includes('queue full')) {
            // Missing model/native library or temporary saturation is not a
            // recording failure. Keep this durable job pending for retry.
            console.warn(`${logTimestamp()} [AI]: 声纹提取暂不可用，保留待处理标注: ${detail}`)
            break
          }
          const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT'
          repository.updateVoiceprint(record.id, {
            version: SPEAKER_VERSION,
            status: missing ? 'unavailable' : 'failed',
            reason: missing ? 'audio_missing' : String(error),
          })
          if (this.extractor.backingOff)
            break
        }
      }
    }
    finally { this.running = false }
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      void this.processPending().catch((error: unknown) => {
        console.warn(`${logTimestamp()} [AI]: 已标注声纹任务失败: ${String(error)}`)
      }).finally(() => {
        if (!this.stopped)
          this.schedule(2_000)
      })
    }, delayMs)
    this.timer.unref()
  }
}
