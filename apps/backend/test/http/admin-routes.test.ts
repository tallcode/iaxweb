import type { SegmentRecord } from '../../src/ai/segment-store.js'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import fastifyCookie from '@fastify/cookie'
import Fastify from 'fastify'
import { AdminAuth, hashPassword } from '../../src/admin/auth.js'
import { LoginRateLimiter } from '../../src/admin/login-rate-limiter.js'
import { SegmentRepository } from '../../src/ai/segment-repository.js'
import { registerAdminRoutes } from '../../src/http/admin-routes.js'

test('admin routes use hardened Fastify cookies and tolerate malformed cookies', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'iaxweb-fastify-admin-'))
  context.after(() => rmSync(directory, { force: true, recursive: true }))
  const usersFile = join(directory, 'admin.json')
  const sessionsFile = join(directory, 'sessions.json')
  writeFileSync(usersFile, JSON.stringify({
    users: [{ passwordHash: hashPassword('secret'), username: 'admin' }],
  }))

  const repository = new SegmentRepository(':memory:')
  context.after(() => repository.close())
  const app = Fastify()
  context.after(() => app.close())
  await app.register(fastifyCookie)
  await app.register(registerAdminRoutes, {
    adminAuth: new AdminAuth(usersFile, sessionsFile),
    loginRateLimiter: new LoginRateLimiter(),
    prefix: '/api/admin',
    recordingsDirectory: directory,
    segmentRepository: repository,
    sessionMaxAgeSeconds: AdminAuth.sessionMaxAgeSeconds,
    spotStore: { publishReview() {} },
  })

  const login = await app.inject({
    headers: { 'x-forwarded-proto': 'https' },
    method: 'POST',
    payload: { password: 'secret', username: 'admin' },
    url: '/api/admin/login',
  })
  assert.equal(login.statusCode, 204)
  const setCookie = login.headers['set-cookie']
  const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie
  assert.match(cookie ?? '', /^admin_token=/)
  assert.match(cookie ?? '', /HttpOnly/)
  assert.match(cookie ?? '', /SameSite=Strict/)
  assert.match(cookie ?? '', /Secure/)

  const authenticated = await app.inject({
    headers: { cookie: cookie!.split(';', 1)[0] },
    url: '/api/admin/segments',
  })
  assert.equal(authenticated.statusCode, 200)
  assert.deepEqual(authenticated.json(), { items: [], page: 1, pageSize: 50, total: 0 })

  const session = await app.inject({
    headers: { cookie: cookie!.split(';', 1)[0] },
    url: '/api/admin/session',
  })
  assert.equal(session.statusCode, 204)
  assert.equal(session.body, '')

  const segment: SegmentRecord = {
    callsign: 'BG5AAA',
    durationMs: 1_000,
    id: 'matching-segment',
    payloads: [],
    recognition: '这里是 BG5AAA',
    timestamp: '2026-08-14T12:00:00.000Z',
    voicedMs: 900,
  }
  repository.insert('1900', segment)
  repository.updateAnalysis(segment)
  const exactSearch = await app.inject({
    headers: { cookie: cookie!.split(';', 1)[0] },
    url: '/api/admin/segments?callsign=bg5aaa',
  })
  assert.equal(exactSearch.statusCode, 200)
  assert.equal(exactSearch.json().total, 1)
  const manualOnlySearch = await app.inject({
    headers: { cookie: cookie!.split(';', 1)[0] },
    url: '/api/admin/segments?callsign=bg5aaa&manualOnly=true',
  })
  assert.equal(manualOnlySearch.statusCode, 200)
  assert.equal(manualOnlySearch.json().total, 0)
  repository.updateManualReview(segment.id, { callsign: 'BG5AAA' })
  const reviewedSearch = await app.inject({
    headers: { cookie: cookie!.split(';', 1)[0] },
    url: '/api/admin/segments?callsign=bg5aaa&manualOnly=true',
  })
  assert.equal(reviewedSearch.json().total, 1)
  const calleeUpdate = await app.inject({
    headers: { cookie: cookie!.split(';', 1)[0] },
    method: 'PATCH',
    payload: { callsign: 'bg5bbb' },
    url: '/api/admin/segments/matching-segment/manual-callee-callsign',
  })
  assert.equal(calleeUpdate.statusCode, 200)
  assert.equal(calleeUpdate.json().calleeCallsign, 'BG5BBB')
  const partialSearch = await app.inject({
    headers: { cookie: cookie!.split(';', 1)[0] },
    url: '/api/admin/segments?callsign=BG5AA',
  })
  assert.equal(partialSearch.statusCode, 200)
  assert.equal(partialSearch.json().total, 0)

  const malformed = await app.inject({
    headers: { cookie: 'broken=%; admin_token=invalid' },
    url: '/api/admin/segments',
  })
  assert.equal(malformed.statusCode, 401)
})

test('admin routes report disabled persistence without parsing a request body', async (context) => {
  const app = Fastify()
  context.after(() => app.close())
  await app.register(fastifyCookie)
  await app.register(registerAdminRoutes, {
    adminAuth: undefined,
    loginRateLimiter: new LoginRateLimiter(),
    recordingsDirectory: '.',
    segmentRepository: undefined,
    sessionMaxAgeSeconds: AdminAuth.sessionMaxAgeSeconds,
    spotStore: { publishReview() {} },
  })

  const response = await app.inject({ method: 'POST', url: '/login' })
  assert.equal(response.statusCode, 503)
  assert.equal(response.body, 'Persistence is disabled')
})
