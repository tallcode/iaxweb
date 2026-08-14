import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AdminAuth } from '../admin/auth.js'
import type { LoginRateLimiter } from '../admin/login-rate-limiter.js'
import type { SegmentRepository } from '../ai/segment-repository.js'
import type { SpotStore } from '../ai/spot-store.js'
import { readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

const ADMIN_COOKIE = 'admin_token'
const CALLSIGN_PATTERN = /^(?:B[ADGHIY]\d[A-Z]{2,3}|N0CALL)$/

interface AdminRoutesOptions {
  adminAuth: AdminAuth | undefined
  loginRateLimiter: LoginRateLimiter
  recordingsDirectory: string
  segmentRepository: SegmentRepository | undefined
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

interface SegmentParams {
  id: string
}

interface SegmentQuery {
  callsign?: string
  page?: string
  pageSize?: string
}

export async function registerAdminRoutes(app: FastifyInstance, options: AdminRoutesOptions): Promise<void> {
  const { adminAuth, segmentRepository } = options

  if (!adminAuth || !segmentRepository) {
    app.all('/*', async (_request, reply) => reply.code(503).send('Persistence is disabled'))
    return
  }

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

  app.get('/session', { preHandler: requireAuthentication }, async (_request, reply) => {
    return reply.header('cache-control', 'no-store').code(204).send()
  })

  app.get<{ Querystring: SegmentQuery }>('/segments', { preHandler: requireAuthentication }, async (request, reply) => {
    const page = parsePage(request.query.page, 1)
    const pageSize = parsePage(request.query.pageSize, 50)
    const callsign = request.query.callsign?.trim().toUpperCase()
    if (callsign !== undefined && !CALLSIGN_PATTERN.test(callsign))
      return reply.code(400).send('Invalid callsign')
    try {
      return reply.header('cache-control', 'no-store').send(segmentRepository.list(page, pageSize, callsign))
    }
    catch {
      return reply.code(400).send('Invalid pagination')
    }
  })

  app.patch<{ Body: ManualCallsignBody, Params: SegmentParams }>(
    '/segments/:id/manual-callsign',
    { preHandler: requireAuthentication },
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
      if (!segmentRepository.updateManualReview(request.params.id, { callsign }))
        return reply.code(404).send('Not Found')

      const segment = segmentRepository.find(request.params.id)
      if (!segment)
        return reply.code(404).send('Not Found')

      options.spotStore.publishReview({
        at: segment.capturedAt,
        callsign: segment.effectiveCallsign ?? 'N0CALL',
        id: segment.id,
        node: segment.nodeId,
      })
      return reply.header('cache-control', 'no-store').send(segment)
    },
  )

  app.get<{ Params: SegmentParams }>(
    '/segments/:id/audio',
    { preHandler: requireAuthentication },
    async (request, reply) => {
      const segment = segmentRepository.find(request.params.id)
      if (!segment)
        return reply.code(404).send('Not Found')

      const day = segment.capturedAt.slice(0, 10).replaceAll('-', '')
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
