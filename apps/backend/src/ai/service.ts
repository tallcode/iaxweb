import type { AudioStateEvent } from '../gateway/nats-audio.js'
import type { SegmentRecognitionOptions } from './segment-recognition.js'
import type { SegmentRecord } from './segment-store.js'
import type { ClosedSegment, DiscardReason } from './segmenter.js'
import { logTimestamp } from './asr-context-files.js'
import { SerialQueue } from './queue.js'
import { SegmentRecognition } from './segment-recognition.js'
import { SegmentStore } from './segment-store.js'
import { NodeSegmenter } from './segmenter.js'

const MAX_QUEUE_DEPTH = 10

interface NodeAiRuntime {
  queue: SerialQueue
  segmenter: NodeSegmenter
  store: SegmentStore
}

export interface AiServiceOptions extends SegmentRecognitionOptions {
  nodeIds: string[]
}

// AI 值机员：按节点维护音频分段及串行识别队列。
export class AiService {
  private readonly recognition: SegmentRecognition
  private readonly nodes = new Map<string, NodeAiRuntime>()
  private stopped = false

  constructor(options: AiServiceOptions) {
    const { config, nodeIds } = options
    this.recognition = new SegmentRecognition(options)
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
    this.recognition.stop()
    for (const runtime of this.nodes.values())
      runtime.queue.clear()
  }

  private enqueue(nodeId: string, segment: ClosedSegment): void {
    const runtime = this.nodes.get(nodeId)
    if (!runtime || this.stopped)
      return
    runtime.queue.add(() => this.recognition.process(nodeId, runtime.store, segment))
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
