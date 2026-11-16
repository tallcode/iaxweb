import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import fastifyCookie from '@fastify/cookie'
import Fastify from 'fastify'
import { AdminAuth, hashPassword } from '../../src/admin/auth.js'
import { LoginRateLimiter } from '../../src/admin/login-rate-limiter.js'
import { RecordRepository } from '../../src/ai/record-repository.js'
import { registerAdminRoutes } from '../../src/http/admin-routes.js'

test('all administrators can manage users without exposing or editing system accounts', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'iaxweb-user-routes-'))
  t.after(() => rmSync(directory, { force: true, recursive: true }))
  const file = join(directory, 'admin.json')
  const passwordHash = hashPassword('secret')
  const config = JSON.stringify({ users: [{ username: 'system', passwordHash }] })
  writeFileSync(file, config)
  const auth = new AdminAuth(file, join(directory, 'sessions.json'))
  for (const role of ['admin', 'editor', 'viewer'] as const)
    await auth.createUser(role, 'secret', role)
  const app = Fastify()
  const repository = new RecordRepository(':memory:')
  t.after(() => repository.close())
  t.after(() => app.close())
  await app.register(fastifyCookie)
  await app.register(registerAdminRoutes, {
    prefix: '/api/admin',
    adminAuth: auth,
    loginRateLimiter: new LoginRateLimiter(),
    recordingsDirectory: directory,
    recordRepository: repository,
    sessionMaxAgeSeconds: AdminAuth.sessionMaxAgeSeconds,
    spotStore: { publishReview() {} },
  })
  assert.equal((await app.inject({ url: '/api/admin/users' })).statusCode, 401)
  for (const username of ['system', 'admin', 'editor', 'viewer']) {
    const token = await auth.login(username, 'secret')
    const headers = { cookie: `admin_token=${token}` }
    const allowed = username === 'system' || username === 'admin'
    const list = await app.inject({ headers, url: '/api/admin/users' })
    assert.equal(list.statusCode, allowed ? 200 : 403)
    if (allowed) {
      assert.equal(Object.hasOwn(list.json(), 'user'), false)
      assert.equal(list.json().items.some((user: { username: string }) => user.username === 'system'), false)
      assert.equal(list.body.includes('passwordHash'), false)
      assert.equal(list.body.includes('scrypt$'), false)
    }
    const created = await app.inject({ headers, method: 'POST', payload: { username: `new-${username}`, password: 'initial', role: 'viewer' }, url: '/api/admin/users' })
    assert.equal(created.statusCode, allowed ? 201 : 403)
    const update = await app.inject({ headers, method: 'PATCH', payload: { role: 'editor' }, url: '/api/admin/users/new-system' })
    assert.equal(update.statusCode, allowed ? 200 : 403)
    const remove = await app.inject({ headers, method: 'DELETE', url: '/api/admin/users/missing' })
    assert.equal(remove.statusCode, allowed ? 404 : 403)
  }
  const token = await auth.login('system', 'secret')
  const headers = { cookie: `admin_token=${token}` }
  const details = await app.inject({ headers, url: '/api/admin/users/new-system' })
  assert.deepEqual(details.json(), { username: 'new-system', role: 'editor' })
  assert.equal((await app.inject({ headers, url: '/api/admin/users/system' })).statusCode, 404)
  assert.equal((await app.inject({ headers, method: 'DELETE', url: '/api/admin/users/system' })).statusCode, 404)
  assert.equal((await app.inject({ headers, method: 'PATCH', payload: { role: 'viewer' }, url: '/api/admin/users/system' })).statusCode, 404)
  assert.equal((await app.inject({ headers, method: 'PATCH', payload: { username: 'system' }, url: '/api/admin/users/new-system' })).statusCode, 409)
  assert.equal((await app.inject({ headers, method: 'POST', payload: { username: 'system', password: 'secret' }, url: '/api/admin/users' })).statusCode, 409)
  assert.equal((await app.inject({ headers, method: 'POST', payload: { username: 'bad', password: '' }, url: '/api/admin/users' })).statusCode, 400)
  assert.equal((await app.inject({ headers, method: 'POST', payload: { username: 'bad', password: 'secret', role: 'system' }, url: '/api/admin/users' })).statusCode, 400)
  const longestName = 'u'.repeat(18)
  const longestPassword = 'p'.repeat(32)
  assert.equal((await app.inject({ headers, method: 'POST', payload: { username: longestName, password: longestPassword }, url: '/api/admin/users' })).statusCode, 201)
  assert.equal((await app.inject({ headers, method: 'POST', payload: { username: `${longestName}x`, password: 'secret' }, url: '/api/admin/users' })).statusCode, 400)
  assert.equal((await app.inject({ headers, method: 'POST', payload: { username: 'too-long-password', password: `${longestPassword}x` }, url: '/api/admin/users' })).statusCode, 400)
  assert.equal((await app.inject({ headers, method: 'PATCH', payload: { username: `${longestName}x` }, url: `/api/admin/users/${longestName}` })).statusCode, 400)
  assert.equal((await app.inject({ headers, method: 'PATCH', payload: { password: `${longestPassword}x` }, url: `/api/admin/users/${longestName}` })).statusCode, 400)
  assert.ok(await auth.login(longestName, longestPassword))
  assert.equal((await app.inject({ headers, method: 'DELETE', url: '/api/admin/users/new-system' })).statusCode, 204)
  assert.equal(auth.findUser('new-system'), undefined)
  assert.equal(readFileSync(file, 'utf8'), config)
})
