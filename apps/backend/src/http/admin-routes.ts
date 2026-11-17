import type { AdminRole } from '@iaxweb/contracts'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AdminAuth } from '../admin/auth.js'
import type { LoginRateLimiter } from '../admin/login-rate-limiter.js'
import type { RecordRepository } from '../records/record-repository.js'
import type { SpotStore } from '../spots/spot-store.js'
import { loginSchema } from '@iaxweb/contracts'
import { registerRecordRoutes } from './record-routes.js'
import { registerUserRoutes } from './user-routes.js'

const ADMIN_COOKIE = 'admin_token'

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

export async function registerAdminRoutes(app: FastifyInstance, options: AdminRoutesOptions): Promise<void> {
  const { adminAuth, recordRepository } = options

  if (!adminAuth || !recordRepository) {
    app.all('/*', async (_request, reply) => reply.code(503).send('Persistence is disabled'))
    return
  }

  app.post<{ Body: LoginBody }>('/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body)
    if (!parsed.success)
      return reply.code(400).send('Invalid login request')
    const { password, username } = parsed.data

    const rateLimitKeys = loginRateLimitKeys(username)
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

  app.register(registerRecordRoutes, {
    adminAuth,
    recordRepository,
    recordingsDirectory: options.recordingsDirectory,
    spotStore: options.spotStore,
    requireAuthentication,
    requireEditor,
    requireAdministrator,
  })

  registerUserRoutes(app, adminAuth, requireAdministrator)

  app.get('/session', { preHandler: requireAuthentication }, async (request, reply) => {
    return reply.header('cache-control', 'no-store').send(adminAuth.getUser(request.cookies[ADMIN_COOKIE]))
  })
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

function loginRateLimitKeys(username: string): string[] {
  return [
    `username:${username.trim().toLowerCase()}`,
  ]
}

function requestUsesHttps(request: FastifyRequest): boolean {
  const forwardedProtocol = request.headers['x-forwarded-proto']
  const protocol = Array.isArray(forwardedProtocol) ? forwardedProtocol[0] : forwardedProtocol?.split(',')[0]
  return protocol?.trim().toLowerCase() === 'https'
    || (request.socket as { encrypted?: boolean }).encrypted === true
}
