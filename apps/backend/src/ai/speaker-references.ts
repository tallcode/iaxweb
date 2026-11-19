import type { SpeakerMatch, SpeakerRecognition, SpeakerRecognitionMeasurements } from '@iaxweb/contracts'
import type { SpeakerReferenceRepository } from '../records/ports.js'
import type { ReadyVoiceprint, SpeakerReferenceGroup, Voiceprint } from '../records/types.js'
import { performance } from 'node:perf_hooks'
import { SPEAKER_REFERENCE_THRESHOLD } from '../records/record-repository.js'
import { logTimestamp } from './asr-context-files.js'
import { createSpeakerMeasurements } from './speaker-measurements.js'
import { SPEAKER_VERSION } from './speaker-model.mjs'
import { SPEAKER_MAX_SAMPLES, SPEAKER_RESOURCE_LIMIT_REASON, SPEAKER_TOO_LONG_REASON } from './speaker-resources.js'
import { readSpeakerWav, speakerWavFile } from './speaker-wav.js'
import { SpeakerExtractor } from './speaker.js'

interface SpeakerReferenceOptions {
  repository: SpeakerReferenceRepository
  recordingsDirectory: string
  modelFile: string
}

type ScoredSpeakerMatch = Omit<SpeakerMatch, 'confidence'>
type RecognitionResult = Omit<SpeakerRecognition, 'measurements'>
const CONFIDENCE_LEVELS = [null, 'low', 'medium', 'high'] as const

function matchConfidence(match: ScoredSpeakerMatch): SpeakerMatch['confidence'] {
  const scores = [
    { similarity: match.minSimilarity, recordCount: match.count },
    { similarity: match.referenceSimilarity, recordCount: match.referenceRecordCount },
    { similarity: match.trimmedReferenceSimilarity, recordCount: match.trimmedReferenceRecordCount },
    ...match.referenceGroups,
  ]
  let confidence: SpeakerMatch['confidence'] = null
  for (const { similarity, recordCount } of scores) {
    if (similarity === null || recordCount < 2)
      continue
    const highThreshold = recordCount >= 10 ? 0.85 : 0.90
    if (recordCount >= 5 && similarity >= highThreshold)
      return 'high'
    const mediumThreshold = recordCount >= 10 ? 0.80 : recordCount >= 5 ? 0.85 : 0.90
    const lowThreshold = recordCount >= 5 ? 0.80 : 0.85
    if (similarity >= mediumThreshold)
      confidence = 'medium'
    else if (confidence === null && similarity >= lowThreshold)
      confidence = 'low'
  }
  return confidence
}

// Live queries, manual queries and reviewed backfill share one native worker.
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

  startLiveRecognition(recordId: string, pcm: Int16Array, voicedMs: number, signal: AbortSignal) {
    const abortSignal = AbortSignal.any([this.abort.signal, signal])
    if (abortSignal.aborted || pcm.length > SPEAKER_MAX_SAMPLES)
      return { voiceprint: Promise.resolve(undefined), matches: Promise.resolve([]) }
    const voiceprint = this.extractor.extract(Float32Array.from(pcm, sample => sample / 32_768), voicedMs, abortSignal)
      .then(result => result.status === 'ready' ? result : undefined)
      .catch(() => undefined)
    const search = voiceprint.then(async (result) => {
      if (!result || abortSignal.aborted)
        return []
      const recognition = await this.searchVoiceprint(recordId, result, abortSignal)
      return abortSignal.aborted ? [] : recognition.matches
    }).catch(() => [])
    // The worker retires asynchronously on cancellation. The AI queue can
    // continue as soon as the deadline expires, independent of worker exit.
    const matches = new Promise<SpeakerMatch[]>((resolve) => {
      const onAbort = () => resolve([])
      abortSignal.addEventListener('abort', onAbort, { once: true })
      void search.then((result) => {
        abortSignal.removeEventListener('abort', onAbort)
        resolve(result)
      })
    })
    return { voiceprint, matches }
  }

  cacheQueryVoiceprint(recordId: string, voiceprint: ReadyVoiceprint): void {
    if (this.stopped)
      return
    try {
      this.options.repository.saveQueryVoiceprint(recordId, voiceprint)
    }
    catch (error) {
      console.warn(`${logTimestamp()} [AI]: 特征缓存写入失败: ${String(error)}`)
    }
  }

  async recognizeRecord(recordId: string, signal?: AbortSignal): Promise<SpeakerRecognition> {
    const measurements = createSpeakerMeasurements()
    const started = performance.now()
    const result = await this.recognizeRecordOnce(recordId, signal, measurements)
    measurements.totalMs = performance.now() - started
    for (const stage of Object.keys(measurements) as Array<keyof SpeakerRecognitionMeasurements>) {
      const value = measurements[stage]
      if (value !== null)
        measurements[stage] = Math.round(value * 100) / 100
    }
    return { ...result, measurements }
  }

  private async recognizeRecordOnce(recordId: string, signal: AbortSignal | undefined, measurements: SpeakerRecognitionMeasurements): Promise<RecognitionResult> {
    const abortSignal = signal ? AbortSignal.any([this.abort.signal, signal]) : this.abort.signal
    const unavailable = (reasonCode: NonNullable<SpeakerRecognition['reasonCode']>, reason: string): RecognitionResult => ({
      recordId,
      threshold: SPEAKER_REFERENCE_THRESHOLD,
      status: 'unavailable',
      reasonCode,
      reason,
      referenceCount: null,
      matches: [],
    })
    const lookupStarted = performance.now()
    const record = this.options.repository.find(recordId)
    const cached = record && this.options.repository.findReadyVoiceprint(recordId)
    measurements.recordLookupMs = performance.now() - lookupStarted
    if (!record)
      return unavailable('record_missing', '记录已不存在，请刷新列表。')
    if (this.stopped)
      return unavailable('extraction_failed', '特征识别服务正在停止，请稍后重试。')
    if (cached)
      return this.searchVoiceprint(recordId, cached, abortSignal, measurements)
    let samples: Float32Array
    const readStarted = performance.now()
    try {
      samples = await readSpeakerWav(speakerWavFile(this.options.recordingsDirectory, { id: record.id, timestamp: record.capturedAt }), abortSignal)
    }
    catch (error) {
      const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT'
      return missing
        ? unavailable('recording_missing', '录音文件不存在或已过期，无法进行特征识别。')
        : unavailable('recording_invalid', '录音文件无法读取或格式无效，无法进行特征识别。')
    }
    finally { measurements.audioReadMs = performance.now() - readStarted }
    let voiceprint: Voiceprint
    try {
      voiceprint = await this.extractor.extract(samples, record.voicedMs, abortSignal, measurements)
    }
    catch (error) {
      const detail = String(error)
      if (detail.includes('timed out'))
        return unavailable('extraction_timeout', '特征提取超时，请稍后重试。')
      if (detail.includes('queue full'))
        return unavailable('extraction_busy', '特征识别任务较多，请稍后重试。')
      if (detail.includes('resource limit') || detail.includes('insufficient memory'))
        return unavailable('resource_limit', '服务器可用内存不足或特征提取达到内存上限，已停止本次任务，请稍后重试。')
      if (!this.stopped && !abortSignal.aborted)
        console.warn(`${logTimestamp()} [AI]: 手动声纹提取失败: ${detail}`)
      return unavailable('extraction_failed', '特征模型暂不可用或提取失败，请稍后重试。')
    }
    if (voiceprint.status !== 'ready') {
      switch (voiceprint.reason) {
        case SPEAKER_TOO_LONG_REASON: return unavailable('audio_too_long', '录音超过当前安全上限 60 秒，未生成特征。')
        case 'interference_tone': return unavailable('interference_tone', '检测到明显窄带干扰，未生成查询特征。')
        case 'interference_high_band': return unavailable('interference_high_band', '检测到高频能量异常，可能存在弱干扰，未生成查询特征。')
        case 'invalid_audio': return unavailable('invalid_audio', '音频采样无效，未生成查询特征。')
        default: return unavailable('insufficient_audio', '有效音频不足 1 秒或没有可用信号，未生成查询特征。')
      }
    }
    this.cacheQueryVoiceprint(recordId, voiceprint)
    return this.searchVoiceprint(recordId, voiceprint, abortSignal, measurements)
  }

  private async searchVoiceprint(recordId: string, voiceprint: ReadyVoiceprint, abortSignal: AbortSignal, measurements?: SpeakerRecognitionMeasurements): Promise<RecognitionResult> {
    const searchStarted = performance.now()
    let search: ReturnType<SpeakerReferenceRepository['searchSpeakerMatches']>
    try {
      search = this.options.repository.searchSpeakerMatches(voiceprint, recordId)
    }
    catch (error) {
      console.warn(`${logTimestamp()} [AI]: 特征检索失败: ${String(error)}`)
      return {
        recordId,
        threshold: SPEAKER_REFERENCE_THRESHOLD,
        status: 'unavailable',
        reasonCode: 'search_failed',
        reason: '特征匹配失败，请稍后重试。',
        referenceCount: null,
        matches: [],
      }
    }
    finally {
      if (measurements)
        measurements.databaseSearchMs = performance.now() - searchStarted
    }
    const matches: ScoredSpeakerMatch[] = search.matches.map(match => ({
      ...match,
      referenceSimilarity: null,
      referenceRecordCount: 0,
      trimmedReferenceSimilarity: null,
      trimmedReferenceRecordCount: 0,
      referenceGroups: [],
    }))
    if (matches.length > 0) {
      let groups: SpeakerReferenceGroup[] = []
      const lookupStarted = performance.now()
      try {
        groups = this.options.repository.recentSpeakerReferences(matches.map(match => match.callsign), recordId)
      }
      catch { /* Supplementary scores must not discard the original matches. */ }
      finally {
        if (measurements)
          measurements.referenceLookupMs = performance.now() - lookupStarted
      }
      if (groups.length > 0) {
        const referenceStarted = performance.now()
        try {
          const scores = await this.extractor.scoreReferences(voiceprint.embedding, groups, abortSignal)
          const byCallsign = new Map(scores.map(score => [score.callsign, score]))
          for (const match of matches) {
            const score = byCallsign.get(match.callsign)
            if (score) {
              match.referenceSimilarity = score.referenceSimilarity
              match.referenceRecordCount = score.referenceRecordCount
              match.trimmedReferenceSimilarity = score.trimmedReferenceSimilarity
              match.trimmedReferenceRecordCount = score.trimmedReferenceRecordCount
              match.referenceGroups = score.referenceGroups
            }
          }
        }
        catch { /* A failed/aborted reference job leaves its score unavailable. */ }
        finally {
          if (measurements)
            measurements.referenceMatchMs = performance.now() - referenceStarted
        }
      }
    }
    let confidenceCeiling = CONFIDENCE_LEVELS.length - 1
    const rankedMatches = matches.map(match => ({
      match,
      highestScore: Math.max(
        match.minSimilarity,
        match.referenceSimilarity ?? -Infinity,
        match.trimmedReferenceSimilarity ?? -Infinity,
        ...match.referenceGroups.map(group => group.similarity),
      ),
    }))
      .sort((left, right) => right.highestScore - left.highestScore)
      .map(({ match }) => {
        confidenceCeiling = Math.min(confidenceCeiling, CONFIDENCE_LEVELS.indexOf(matchConfidence(match)))
        return { ...match, confidence: CONFIDENCE_LEVELS[confidenceCeiling]! }
      })
    return {
      recordId,
      threshold: SPEAKER_REFERENCE_THRESHOLD,
      status: matches.length > 0 ? 'matched' : 'no_match',
      reasonCode: matches.length > 0 ? null : search.referenceCount === 0 ? 'empty_reference_library' : 'below_threshold',
      reason: matches.length > 0
        ? null
        : search.referenceCount === 0
          ? '参考库中暂无其他已标注、质量合格且有有效主叫呼号的同版本特征。'
          : `没有找到相似度大于 ${SPEAKER_REFERENCE_THRESHOLD.toFixed(2)} 的已标注录音。`,
      referenceCount: search.referenceCount,
      matches: rankedMatches,
    }
  }

  // One job per tick leaves CPU and memory headroom for the radio gateway.
  // Missing/pending reviewed rows form a durable queue, including after restart.
  async processPending(): Promise<void> {
    if (this.stopped || this.running || this.extractor.backingOff || this.extractor.busy)
      return
    this.running = true
    const { repository, recordingsDirectory } = this.options
    try {
      for (const record of repository.pendingReviewedVoiceprints(1)) {
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
          if (this.extractor.busy)
            break
          const voiceprint = await this.extractor.extract(samples, record.voicedMs)
          if (this.stopped)
            break
          repository.updateVoiceprint(record.id, voiceprint)
        }
        catch (error) {
          if (this.stopped)
            break
          const detail = String(error)
          if (detail.includes('resource limit')) {
            repository.updateVoiceprint(record.id, { version: SPEAKER_VERSION, status: 'unavailable', reason: SPEAKER_RESOURCE_LIMIT_REASON })
            console.warn(`${logTimestamp()} [AI]: 声纹提取达到内存上限，已停止任务并暂停重算: ${detail}`)
            break
          }
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
          this.schedule(5_000)
      })
    }, delayMs)
    this.timer.unref()
  }
}
