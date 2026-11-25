import type { AdminRecordPage } from '@iaxweb/contracts'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AdminAuth } from '../admin/auth.js'
import type { SpeakerReferenceService } from '../ai/speaker-references.js'
import type { NodeDefinitions } from '../allmon3/types.js'
import type { RecordListRepository } from '../records/ports.js'
import type { SpotStore } from '../spots/spot-store.js'
import { performance } from 'node:perf_hooks'
import { manualCallsignSchema, manualRecognitionSchema, RECORD_CALLSIGN_FILTER_PATTERN, reviewSchema } from '@iaxweb/contracts'
import { RecordingStore } from '../records/recording-store.js'
import { RecordReviewError, RecordReviewService } from '../records/review-service.js'

interface RecordParams { id: string }
interface RecordQuery { callsign?: string, editedOnly?: string, reviewedOnly?: string, page?: string, pageSize?: string }
type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | undefined>
interface RecordRoutesOptions {
  adminAuth: AdminAuth
  nodeDefinitions?: NodeDefinitions
  recordRepository: RecordListRepository
  speakerReferences?: Pick<SpeakerReferenceService, 'recognizeRecord'>
  recordingsDirectory: string
  spotStore?: Pick<SpotStore, 'publishReview'>
  requireAuthentication: Guard
  requireEditor: Guard
  requireAdministrator: Guard
}

export async function registerRecordRoutes(app: FastifyInstance, options: RecordRoutesOptions): Promise<void> {
  const { nodeDefinitions, recordRepository, requireAuthentication, requireEditor, requireAdministrator } = options
  const recordings = new RecordingStore(options.recordingsDirectory)
  const reviews = new RecordReviewService(recordRepository, recordings, options.spotStore)
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof RecordReviewError)
      return reply.code(error.statusCode).send({ message: error.message })
    request.log.error({ err: error }, 'Record operation failed')
    const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500
    return reply.code(statusCode).send({ message: statusCode === 413 ? '请求内容过长' : '记录操作失败，请稍后重试' })
  })

  app.get<{ Querystring: RecordQuery }>('/records', { preHandler: requireAuthentication }, async (request, reply) => {
    const page = parsePage(request.query.page, 1)
    const pageSize = parsePage(request.query.pageSize, 50)
    const filter = request.query.callsign
    const callsign = typeof filter === 'string' ? filter.trim().toUpperCase() : undefined
    if (filter !== undefined && (callsign === undefined || !RECORD_CALLSIGN_FILTER_PATTERN.test(callsign)))
      return reply.code(400).send('Invalid callsign')
    let result
    const queryStarted = performance.now()
    try {
      result = recordRepository.list(page, pageSize, callsign, request.query.editedOnly === 'true', request.query.reviewedOnly === 'true')
    }
    catch {
      return reply.code(400).send('Invalid pagination')
    }
    const queryDuration = performance.now() - queryStarted
    const recordingStarted = performance.now()
    const items = await Promise.all(result.items.map(async item => ({
      ...item,
      hasAudio: await recordings.has(item.id, item.capturedAt),
      sourceRepeaterName: item.sourceRepeaterId ? nodeDefinitions?.[item.sourceRepeaterId]?.NAME?.trim() || null : null,
    })))
    const recordingDuration = performance.now() - recordingStarted
    const response: AdminRecordPage = {
      ...result,
      items,
    }
    return reply.header('cache-control', 'no-store')
      .header('server-timing', `db;dur=${queryDuration.toFixed(2)}, recordings;dur=${recordingDuration.toFixed(2)}`)
      .send(response)
  })

  for (const field of ['manual-callsign', 'manual-callee-callsign'] as const) {
    app.patch<{ Body: unknown, Params: RecordParams }>(`/records/:id/${field}`, { preHandler: requireEditor }, async (request, reply) => {
      const parsed = manualCallsignSchema.safeParse(request.body)
      if (!parsed.success)
        return reply.code(400).send('Invalid callsign')
      const patch = field === 'manual-callsign' ? { callsign: parsed.data.callsign } : { calleeCallsign: parsed.data.callsign }
      return reply.header('cache-control', 'no-store').send(reviews.update(request.params.id, patch, options.adminAuth.getUser(request.cookies.admin_token)))
    })
  }

  app.patch<{ Body: unknown, Params: RecordParams }>('/records/:id/manual-recognition', { preHandler: requireEditor }, async (request, reply) => {
    const parsed = manualRecognitionSchema.safeParse(request.body)
    if (!parsed.success)
      return reply.code(400).send({ message: '识别文本应在 1000 字以内' })
    return reply.header('cache-control', 'no-store').send(reviews.update(request.params.id, parsed.data, options.adminAuth.getUser(request.cookies.admin_token)))
  })

  app.patch<{ Body: unknown, Params: RecordParams }>('/records/:id/manual-review', { preHandler: requireAdministrator }, async (request, reply) => {
    const parsed = reviewSchema.safeParse(request.body)
    if (!parsed.success)
      return reply.code(400).send('Invalid review status')
    return reply.header('cache-control', 'no-store').send(reviews.update(request.params.id, parsed.data, options.adminAuth.getUser(request.cookies.admin_token)))
  })

  app.post<{ Params: RecordParams }>('/records/:id/speaker-recognition', { preHandler: requireAdministrator }, async (request, reply) => {
    if (!options.speakerReferences)
      return reply.code(503).send({ message: '特征识别暂不可用' })
    reviews.find(request.params.id)
    const controller = new AbortController()
    const onClose = () => {
      if (!reply.raw.writableEnded)
        controller.abort()
    }
    reply.raw.once('close', onClose)
    try {
      const result = await options.speakerReferences.recognizeRecord(request.params.id, controller.signal)
      if (controller.signal.aborted) {
        reply.hijack()
        return
      }
      return reply.header('cache-control', 'no-store').send(result)
    }
    finally { reply.raw.removeListener('close', onClose) }
  })

  app.delete<{ Params: RecordParams }>('/records/:id', { preHandler: requireAdministrator }, async (request, reply) => {
    reviews.delete(request.params.id)
    return reply.header('cache-control', 'no-store').code(204).send()
  })

  app.get<{ Params: RecordParams }>('/records/:id/audio', { preHandler: requireAuthentication }, async (request, reply) => {
    const record = reviews.find(request.params.id)
    try {
      const wav = await recordings.read(record.id, record.capturedAt)
      return reply.headers({ 'cache-control': 'private, no-store', 'content-type': 'audio/wav' }).send(wav)
    }
    catch {
      return reply.code(404).send('Recording not found')
    }
  })
}

function parsePage(value: string | undefined, fallback: number): number {
  if (value === undefined)
    return fallback
  const parsed = Number(value)
  return Number.isInteger(parsed) ? parsed : Number.NaN
}
