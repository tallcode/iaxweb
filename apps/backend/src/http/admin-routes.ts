import type { AdminRecordPage, AdminRole } from '@iaxweb/contracts'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AdminAuth } from '../admin/auth.js'
import type { LoginRateLimiter } from '../admin/login-rate-limiter.js'
import type { RecordRepository } from '../ai/record-repository.js'
import type { SpotStore } from '../ai/spot-store.js'
import { readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import { RecordingStore } from '../ai/recording-store.js'
import { registerUserRoutes } from './user-routes.js'

const ADMIN_COOKIE = 'admin_token'
const CALLSIGN_PATTERN = /^(?:B[ADGHIY]\d[A-Z]{2,3}|N0CALL)$/

interface AdminRoutesOptions {
  adminAuth: AdminAuth | undefined
  loginRateLimiter: LoginRateLimiter
  recordingsDirectory: string
  recordRepository: RecordRepository | undefined
  sessionMaxAgeSeconds: number
  spotStore: Pick<SpotStore, 'publishReview'>
}

interface LoginBody {
  password?: unknown
  username?: unknown
}

interface ManualCallsignBody {
  callsign?: unknown
}

interface ManualRecognitionBody {
  recognition?: unknown
}

interface ReviewBody {
  reviewed?: unknown
}

interface RecordParams {
  id: string
}

interface RecordQuery {
  callsign?: string
  editedOnly?: string
  reviewedOnly?: string
  page?: string
  pageSize?: string
}

export async function registerAdminRoutes(app: FastifyInstance, options: AdminRoutesOptions): Promise<void> {
  const { adminAuth, recordRepository } = options

  if (!adminAuth || !recordRepository) {
    app.all('/*', async (_request, reply) => reply.code(503).send('Persistence is disabled'))
    return
  }

  const recordings = new RecordingStore(options.recordingsDirectory)

  app.post<{ Body: LoginBody }>('/login', async (request, reply) => {
    const { password, username } = request.body ?? {}
    if (typeof username !== 'string' || typeof password !== 'string')
      return reply.code(400).send('Invalid login request')

    const rateLimitKeys = loginRateLimitKeys(request, username)
    const retryAfterMs = options.loginRateLimiter.consume(rateLimitKeys)
    if (retryAfterMs !== undefined) {
      return reply
        .header('retry-after', String(Math.ceil(retryAfterMs / 1_000)))
        .code(429)
        .send('Too many login attempts')
    }

    const token = await adminAuth.login(username, password)
    if (!token)
      return reply.code(401).send('Invalid username or password')

    options.loginRateLimiter.reset(rateLimitKeys)
    return reply
      .setCookie(ADMIN_COOKIE, token, cookieOptions(options.sessionMaxAgeSeconds, requestUsesHttps(request)))
      .code(204)
      .send()
  })

  app.post('/logout', async (request, reply) => {
    adminAuth.logout(request.cookies[ADMIN_COOKIE])
    return reply
      .clearCookie(ADMIN_COOKIE, cookieOptions(0, requestUsesHttps(request)))
      .code(204)
      .send()
  })

  const requireAuthentication = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!adminAuth.isAuthenticated(request.cookies[ADMIN_COOKIE]))
      return reply.code(401).send('Unauthorized')
  }

  const requireRoles = (...roles: AdminRole[]) => async (request: FastifyRequest, reply: FastifyReply) => {
    const user = adminAuth.getUser(request.cookies[ADMIN_COOKIE])
    if (!user)
      return reply.code(401).send('Unauthorized')
    if (!roles.includes(user.role))
      return reply.code(403).send('Forbidden')
  }
  const requireEditor = requireRoles('admin', 'editor')
  const requireAdministrator = requireRoles('admin')

  registerUserRoutes(app, adminAuth, requireAdministrator)

  app.get('/session', { preHandler: requireAuthentication }, async (request, reply) => {
    return reply.header('cache-control', 'no-store').send(adminAuth.getUser(request.cookies[ADMIN_COOKIE]))
  })

  app.get<{ Querystring: RecordQuery }>('/records', { preHandler: requireAuthentication }, async (request, reply) => {
    const page = parsePage(request.query.page, 1)
    const pageSize = parsePage(request.query.pageSize, 50)
    const callsign = request.query.callsign?.trim().toUpperCase()
    const editedOnly = request.query.editedOnly === 'true'
    const reviewedOnly = request.query.reviewedOnly === 'true'
    if (callsign !== undefined && !CALLSIGN_PATTERN.test(callsign))
      return reply.code(400).send('Invalid callsign')
    let result
    const queryStarted = performance.now()
    try {
      result = recordRepository.list(page, pageSize, callsign, editedOnly, reviewedOnly)
    }
    catch {
      return reply.code(400).send('Invalid pagination')
    }
    const queryDuration = performance.now() - queryStarted
    try {
      const recordingStarted = performance.now()
      const recordingDates = new Set(await recordings.availableDates())
      const recordingDuration = performance.now() - recordingStarted
      const page: AdminRecordPage = {
        ...result,
        items: result.items.map(item => ({
          ...item,
          hasAudio: recordingDates.has(item.capturedAt.slice(0, 10).replaceAll('-', '')),
        })),
      }
      return reply.header('cache-control', 'no-store')
        .header('server-timing', `db;dur=${queryDuration.toFixed(2)}, recordings;dur=${recordingDuration.toFixed(2)}`)
        .send(page)
    }
    catch (error) {
      request.log.error({ err: error }, 'Failed to scan recording dates')
      return reply.code(500).send('Recording availability is unavailable')
    }
  })

  app.patch<{ Body: ManualCallsignBody, Params: RecordParams }>(
    '/records/:id/manual-callsign',
    { preHandler: requireEditor },
    async (request, reply) => {
      if (!Object.hasOwn(request.body ?? {}, 'callsign')
        || (request.body.callsign !== null && typeof request.body.callsign !== 'string')) {
        return reply.code(400).send('Invalid callsign')
      }

      const callsign = typeof request.body.callsign === 'string'
        ? request.body.callsign.trim().toUpperCase()
        : null
      if (callsign !== null && !CALLSIGN_PATTERN.test(callsign))
        return reply.code(400).send('Invalid callsign')
      if (!recordRepository.updateManualReview(request.params.id, { callsign }))
        return reply.code(404).send('Not Found')

      const record = recordRepository.find(request.params.id)
      if (!record)
        return reply.code(404).send('Not Found')

      options.spotStore.publishReview({
        at: record.capturedAt,
        callsign: record.effectiveCallsign ?? 'N0CALL',
        id: record.id,
        node: record.nodeId,
      })
      return reply.header('cache-control', 'no-store').send(record)
    },
  )

  app.patch<{ Body: ManualCallsignBody, Params: RecordParams }>(
    '/records/:id/manual-callee-callsign',
    { preHandler: requireEditor },
    async (request, reply) => {
      if (!Object.hasOwn(request.body ?? {}, 'callsign')
        || (request.body.callsign !== null && typeof request.body.callsign !== 'string')) {
        return reply.code(400).send('Invalid callsign')
      }

      const callsign = typeof request.body.callsign === 'string'
        ? request.body.callsign.trim().toUpperCase()
        : null
      if (callsign !== null && !CALLSIGN_PATTERN.test(callsign))
        return reply.code(400).send('Invalid callsign')
      if (!recordRepository.updateManualReview(request.params.id, { calleeCallsign: callsign }))
        return reply.code(404).send('Not Found')

      const record = recordRepository.find(request.params.id)
      if (!record)
        return reply.code(404).send('Not Found')
      return reply.header('cache-control', 'no-store').send(record)
    },
  )

  app.patch<{ Body: ManualRecognitionBody, Params: RecordParams }>(
    '/records/:id/manual-recognition',
    { preHandler: requireEditor },
    async (request, reply) => {
      const body = request.body
      if (!body || !Object.hasOwn(body, 'recognition')
        || (body.recognition !== null && typeof body.recognition !== 'string')
        || (typeof body.recognition === 'string' && body.recognition.length > 20_000)) {
        return reply.code(400).send('Invalid recognition text')
      }
      const recognition = typeof body.recognition === 'string' ? body.recognition.trim() || null : null
      if (!recordRepository.updateManualReview(request.params.id, { recognition }))
        return reply.code(404).send('Not Found')
      return reply.header('cache-control', 'no-store').send(recordRepository.find(request.params.id))
    },
  )

  app.patch<{ Body: ReviewBody, Params: RecordParams }>(
    '/records/:id/manual-review',
    { preHandler: requireAdministrator },
    async (request, reply) => {
      if (typeof request.body?.reviewed !== 'boolean')
        return reply.code(400).send('Invalid review status')
      if (!recordRepository.updateManualReview(request.params.id, { reviewed: request.body.reviewed }))
        return reply.code(404).send('Not Found')
      return reply.header('cache-control', 'no-store').send(recordRepository.find(request.params.id))
    },
  )

  app.delete<{ Params: RecordParams }>(
    '/records/:id',
    { preHandler: requireAdministrator },
    async (request, reply) => {
      const record = recordRepository.find(request.params.id)
      if (!record)
        return reply.code(404).send('Not Found')
      try {
        if (!recordRepository.delete(record.id, () => recordings.remove(record.id, record.capturedAt)))
          return reply.code(404).send('Not Found')
      }
      catch (error) {
        request.log.error({ err: error, recordId: record.id }, 'Failed to delete record and recording')
        return reply.code(500).send('Failed to delete record and recording')
      }
      options.spotStore.publishReview({
        at: record.capturedAt,
        callsign: 'N0CALL',
        id: record.id,
        node: record.nodeId,
      })
      return reply.header('cache-control', 'no-store').code(204).send()
    },
  )

  app.get<{ Params: RecordParams }>(
    '/records/:id/audio',
    { preHandler: requireAuthentication },
    async (request, reply) => {
      const record = recordRepository.find(request.params.id)
      if (!record)
        return reply.code(404).send('Not Found')

      const day = record.capturedAt.slice(0, 10).replaceAll('-', '')
      const recordingsRoot = resolve(options.recordingsDirectory)
      const file = resolve(recordingsRoot, day, `${request.params.id}.wav`)
      if (!file.startsWith(`${recordingsRoot}${sep}`))
        return reply.code(400).send('Bad Request')

      try {
        const wav = await readFile(file)
        return reply
          .headers({ 'cache-control': 'private, no-store', 'content-type': 'audio/wav' })
          .send(wav)
      }
      catch {
        return reply.code(404).send('Recording not found')
      }
    },
  )
}

function cookieOptions(maxAge: number, secure: boolean): {
  httpOnly: true
  maxAge: number
  path: '/'
  sameSite: 'strict'
  secure: boolean
} {
  return { httpOnly: true, maxAge, path: '/', sameSite: 'strict', secure }
}

function loginRateLimitKeys(request: FastifyRequest, username: string): string[] {
  return [
    `address:${request.socket.remoteAddress ?? 'unknown'}`,
    `username:${username.trim().toLowerCase()}`,
  ]
}

function parsePage(value: string | undefined, fallback: number): number {
  if (value === undefined)
    return fallback
  const parsed = Number(value)
  return Number.isInteger(parsed) ? parsed : Number.NaN
}

function requestUsesHttps(request: FastifyRequest): boolean {
  const forwardedProtocol = request.headers['x-forwarded-proto']
  const protocol = Array.isArray(forwardedProtocol) ? forwardedProtocol[0] : forwardedProtocol?.split(',')[0]
  return protocol?.trim().toLowerCase() === 'https'
    || (request.socket as { encrypted?: boolean }).encrypted === true
}
