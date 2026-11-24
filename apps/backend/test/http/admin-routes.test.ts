import type { AdminRecordPage } from '@iaxweb/contracts'
import type { SegmentRecord } from '../../src/ai/segment-store.js'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import fastifyCookie from '@fastify/cookie'
import Fastify from 'fastify'
import { AdminAuth, hashPassword } from '../../src/admin/auth.js'
import { LoginRateLimiter } from '../../src/admin/login-rate-limiter.js'
import { registerAdminRoutes } from '../../src/http/admin-routes.js'
import { RecordRepository } from '../../src/records/record-repository.js'
import { RecordingStore } from '../../src/records/recording-store.js'

test('admin routes use hardened Fastify cookies and tolerate malformed cookies', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'iaxweb-fastify-admin-'))
  context.after(() => rmSync(directory, { force: true, recursive: true }))
  const usersFile = join(directory, 'admin.json')
  const sessionsFile = join(directory, 'sessions.json')
  writeFileSync(usersFile, JSON.stringify({
    users: [{ passwordHash: hashPassword('secret'), role: 'admin', username: 'admin' }],
  }))
  mkdirSync(join(directory, '20260814'))

  const repository = new RecordRepository(':memory:')
  context.after(() => repository.close())
  const app = Fastify()
  context.after(() => app.close())
  await app.register(fastifyCookie)
  await app.register(registerAdminRoutes, {
    adminAuth: new AdminAuth(usersFile, sessionsFile),
    loginRateLimiter: new LoginRateLimiter(),
    prefix: '/api/admin',
    recordingsDirectory: directory,
    recordRepository: repository,
    sessionMaxAgeSeconds: AdminAuth.sessionMaxAgeSeconds,
    spotStore: { publishReview() {} },
  })

  for (let attempt = 0; attempt < 11; attempt++) {
    const response = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { username: `missing-${attempt}`, password: 'bad' } })
    assert.equal(response.statusCode, 401, 'different usernames must not share an IP limit')
  }
  for (let attempt = 0; attempt < 11; attempt++) {
    const response = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { username: 'same-account', password: 'bad' } })
    assert.equal(response.statusCode, attempt < 10 ? 401 : 429)
  }

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
    url: '/api/admin/records',
  })
  assert.equal(authenticated.statusCode, 200)
  assert.deepEqual(authenticated.json(), { items: [], page: 1, pageSize: 50, total: 0 })
  assert.match(String(authenticated.headers['server-timing']), /^db;dur=\d+\.\d{2}, recordings;dur=\d+\.\d{2}$/)

  const session = await app.inject({
    headers: { cookie: cookie!.split(';', 1)[0] },
    url: '/api/admin/session',
  })
  assert.equal(session.statusCode, 200)
  assert.deepEqual(session.json(), { role: 'admin', username: 'admin', system: true })

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
  repository.updateAutomaticCallsign(segment)
  const exactSearch = await app.inject({
    headers: { cookie: cookie!.split(';', 1)[0] },
    url: '/api/admin/records?callsign=bg5aaa',
  })
  assert.equal(exactSearch.statusCode, 200)
  assert.equal(exactSearch.json().items[0].hasAudio, false)
  assert.equal(Object.hasOwn(exactSearch.json(), 'recordingDates'), false)
  assert.equal(Object.hasOwn(exactSearch.json(), 'user'), false)
  assert.equal(exactSearch.json().total, 1)
  const editedOnlySearch = await app.inject({
    headers: { cookie: cookie!.split(';', 1)[0] },
    url: '/api/admin/records?callsign=bg5aaa&editedOnly=true',
  })
  assert.equal(editedOnlySearch.statusCode, 200)
  assert.equal(editedOnlySearch.json().total, 0)
  const reviewedOnlySearch = await app.inject({
    headers: { cookie: cookie!.split(';', 1)[0] },
    url: '/api/admin/records?reviewedOnly=true',
  })
  assert.equal(reviewedOnlySearch.statusCode, 200)
  assert.equal(reviewedOnlySearch.json().total, 0)
  repository.updateManualReview(segment.id, { callsign: 'BG5AAA' })
  const reviewedSearch = await app.inject({
    headers: { cookie: cookie!.split(';', 1)[0] },
    url: '/api/admin/records?callsign=bg5aaa&editedOnly=true',
  })
  assert.equal(reviewedSearch.json().total, 1)
  const calleeUpdate = await app.inject({
    headers: { cookie: cookie!.split(';', 1)[0] },
    method: 'PATCH',
    payload: { callsign: 'bg5bbb' },
    url: '/api/admin/records/matching-segment/manual-callee-callsign',
  })
  assert.equal(calleeUpdate.statusCode, 200)
  assert.equal(calleeUpdate.json().calleeCallsign, 'BG5BBB')
  const headers = { cookie: cookie!.split(';', 1)[0] }
  const manualText = await app.inject({ headers, method: 'PATCH', payload: { recognition: ' 人工确认文本 ' }, url: '/api/admin/records/matching-segment/manual-recognition' })
  assert.equal(manualText.statusCode, 200)
  assert.equal(manualText.json().manualRecognition, '人工确认文本')
  assert.equal(manualText.json().recognition, segment.recognition)
  assert.equal(manualText.json().reviewed, false)
  for (const reviewed of [true, false]) {
    const review = await app.inject({ headers, method: 'PATCH', payload: { reviewed }, url: '/api/admin/records/matching-segment/manual-review' })
    assert.equal(review.statusCode, 200)
    assert.equal(review.json().reviewed, reviewed)
    assert.equal(review.json().manualRecognition, '人工确认文本')
    const filtered = await app.inject({ headers, url: '/api/admin/records?editedOnly=true&reviewedOnly=true' })
    assert.equal(filtered.statusCode, 200)
    assert.equal(filtered.json().total, reviewed ? 1 : 0)
  }
  for (const payload of [{}, { reviewed: 'false' }, { reviewed: null }, { reviewed: 1 }]) {
    const invalid = await app.inject({ headers, method: 'PATCH', payload, url: '/api/admin/records/matching-segment/manual-review' })
    assert.equal(invalid.statusCode, 400)
  }
  const clearText = await app.inject({ headers, method: 'PATCH', payload: { recognition: '' }, url: '/api/admin/records/matching-segment/manual-recognition' })
  assert.equal(clearText.json().manualRecognition, null)
  const unauthenticated = await app.inject({ method: 'PATCH', payload: { reviewed: true }, url: '/api/admin/records/matching-segment/manual-review' })
  assert.equal(unauthenticated.statusCode, 401)
  const missing = await app.inject({ headers, method: 'PATCH', payload: { reviewed: true }, url: '/api/admin/records/missing/manual-review' })
  assert.equal(missing.statusCode, 404)
  const emptyCaller = { ...segment, id: 'empty-caller' }
  repository.insert('1900', emptyCaller)
  const callerUrl = '/api/admin/records/empty-caller/manual-callsign'
  const reviewUrl = '/api/admin/records/empty-caller/manual-review'
  const mark = () => app.inject({ headers, method: 'PATCH', payload: { reviewed: true }, url: reviewUrl })
  assert.equal((await mark()).statusCode, 400)
  assert.equal(repository.find(emptyCaller.id)?.reviewed, false)
  await app.inject({ headers, method: 'PATCH', payload: { callsign: 'BG5BBB' }, url: '/api/admin/records/empty-caller/manual-callee-callsign' })
  assert.equal((await mark()).statusCode, 400, 'callee cannot substitute for caller')
  await app.inject({ headers, method: 'PATCH', payload: { callsign: 'BG5CCC' }, url: callerUrl })
  assert.equal((await mark()).statusCode, 200)
  assert.equal((await app.inject({ headers, method: 'PATCH', payload: { callsign: null }, url: callerUrl })).statusCode, 400)
  assert.equal(repository.find(emptyCaller.id)?.manualCallsign, 'BG5CCC')
  assert.equal((await app.inject({ headers, method: 'PATCH', payload: { reviewed: false }, url: reviewUrl })).statusCode, 200)
  assert.equal((await app.inject({ headers, method: 'PATCH', payload: { callsign: null }, url: callerUrl })).statusCode, 200)
  repository.updateAutomaticCallsign(emptyCaller)
  const aiOnlyReview = await mark()
  assert.equal(aiOnlyReview.statusCode, 200)
  assert.equal(aiOnlyReview.json().manualCallsign, null)
  assert.equal(aiOnlyReview.json().effectiveCallsign, segment.callsign)
  const partialSearch = await app.inject({
    headers: { cookie: cookie!.split(';', 1)[0] },
    url: '/api/admin/records?callsign=BG5AA',
  })
  assert.equal(partialSearch.statusCode, 200)
  assert.equal(partialSearch.json().total, 0)

  await context.test('filters the effective caller by a single leading-percent suffix', async () => {
    repository.updateManualReview(segment.id, { callsign: 'BA3XAA' })
    const search = (callsign: string, page = 1) => {
      const query = new URLSearchParams({ callsign, page: String(page), pageSize: '1' })
      return app.inject({ headers, url: `/api/admin/records?${query}` })
    }

    const first = await search('%aa')
    const second = await search('%aa', 2)
    assert.equal(first.statusCode, 200)
    assert.equal(second.statusCode, 200)
    const firstPage = first.json<AdminRecordPage>()
    const secondPage = second.json<AdminRecordPage>()
    assert.deepEqual([firstPage.total, secondPage.total], [2, 2])
    assert.deepEqual(firstPage.items.map(item => [item.id, item.callsign, item.effectiveCallsign]), [[segment.id, 'BG5AAA', 'BA3XAA']])
    assert.deepEqual(secondPage.items.map(item => [item.id, item.effectiveCallsign]), [[emptyCaller.id, 'BG5AAA']])

    const original = await search('%aaa')
    assert.equal(original.statusCode, 200)
    assert.equal(original.json<AdminRecordPage>().total, 1)
    assert.equal(original.json<AdminRecordPage>().items[0]?.id, emptyCaller.id)
    for (const callsign of ['%5a', '%bbb']) {
      const response = await search(callsign)
      assert.equal(response.statusCode, 200)
      assert.equal(response.json<AdminRecordPage>().total, 0)
    }
    for (const callsign of ['%A', 'A%', '%%AA', '%AA%', '_', '%A_', '%éa']) {
      assert.equal((await search(callsign)).statusCode, 400, callsign)
    }
  })

  const malformed = await app.inject({
    headers: { cookie: 'broken=%; admin_token=invalid' },
    url: '/api/admin/records',
  })
  assert.equal(malformed.statusCode, 401)

  const deletable = { ...segment, id: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789' }
  repository.insert('1900', deletable)
  const recordings = new RecordingStore(directory)
  const wav = recordings.save(deletable.id, deletable.timestamp, new Uint8Array([82, 73, 70, 70]))
  const deleteUrl = `/api/admin/records/${deletable.id}`
  assert.equal((await app.inject({ method: 'DELETE', url: deleteUrl })).statusCode, 401)
  assert.ok(repository.find(deletable.id))
  assert.equal(existsSync(wav), true)
  const deleted = await app.inject({ headers, method: 'DELETE', url: deleteUrl })
  assert.equal(deleted.statusCode, 204)
  assert.equal(repository.find(deletable.id), undefined)
  assert.equal(existsSync(wav), false)
  assert.ok(repository.find(segment.id))
  assert.equal((await app.inject({ headers, method: 'DELETE', url: deleteUrl })).statusCode, 404)

  repository.insert('1900', deletable)
  mkdirSync(wav)
  assert.equal((await app.inject({ headers, method: 'DELETE', url: deleteUrl })).statusCode, 500)
  assert.ok(repository.find(deletable.id))
  assert.equal(existsSync(wav), true)
  rmSync(wav, { recursive: true })
  assert.equal((await app.inject({ headers, method: 'DELETE', url: deleteUrl })).statusCode, 204)
  assert.equal(repository.find(deletable.id), undefined)
})

test('admin routes report disabled persistence without parsing a request body', async (context) => {
  const app = Fastify()
  context.after(() => app.close())
  await app.register(fastifyCookie)
  await app.register(registerAdminRoutes, {
    adminAuth: undefined,
    loginRateLimiter: new LoginRateLimiter(),
    recordingsDirectory: '.',
    recordRepository: undefined,
    sessionMaxAgeSeconds: AdminAuth.sessionMaxAgeSeconds,
    spotStore: { publishReview() {} },
  })

  const response = await app.inject({ method: 'POST', url: '/login' })
  assert.equal(response.statusCode, 503)
  assert.equal(response.body, 'Persistence is disabled')
})

test('editors can edit fields but only administrators can annotate or delete', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'iaxweb-admin-permissions-'))
  context.after(() => rmSync(directory, { force: true, recursive: true }))
  const passwordHash = hashPassword('secret')
  const usersFile = join(directory, 'admin.json')
  writeFileSync(usersFile, JSON.stringify({ users: [{ username: 'admin', passwordHash }] }))
  writeFileSync(join(directory, 'users.json'), JSON.stringify({ users: [
    { username: 'editor', passwordHash, role: 'editor' },
    { username: 'viewer', passwordHash, role: 'viewer' },
    { username: 'legacy', passwordHash },
    { username: 'empty-role', passwordHash, role: '' },
  ] }))
  const auth = new AdminAuth(usersFile, join(directory, 'sessions.json'))
  const repository = new RecordRepository(':memory:')
  context.after(() => repository.close())
  const segment: SegmentRecord = {
    id: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789',
    callsign: 'BG5AAA',
    durationMs: 1000,
    voicedMs: 900,
    recognition: '这里是 BG5AAA',
    timestamp: '2026-11-16T00:30:00.000Z',
    payloads: [],
  }
  repository.insert('1900', segment)
  repository.updateAutomaticCallsign(segment)
  const wav = new RecordingStore(directory).save(segment.id, segment.timestamp, new Uint8Array([82, 73, 70, 70]))
  const app = Fastify()
  context.after(() => app.close())
  await app.register(fastifyCookie)
  await app.register(registerAdminRoutes, {
    prefix: '/api/admin',
    adminAuth: auth,
    loginRateLimiter: new LoginRateLimiter(),
    recordRepository: repository,
    recordingsDirectory: directory,
    sessionMaxAgeSeconds: AdminAuth.sessionMaxAgeSeconds,
    spotStore: { publishReview() {} },
  })
  for (const username of ['editor', 'viewer', 'legacy', 'empty-role']) {
    const token = await auth.login(username, 'secret')
    assert.ok(token)
    const headers = { cookie: `admin_token=${token}` }
    const role = username === 'editor' ? 'editor' : 'viewer'
    const session = await app.inject({ headers, url: '/api/admin/session' })
    assert.deepEqual(session.json(), { username, role })
    const page = await app.inject({ headers, url: '/api/admin/records' })
    assert.equal(page.statusCode, 200)
    assert.equal(Object.hasOwn(page.json(), 'user'), false)
    assert.equal(Object.hasOwn(page.json(), 'recordingDates'), false)
    assert.equal((await app.inject({ headers, url: `/api/admin/records/${segment.id}/audio` })).statusCode, 200)
    for (const [endpoint, payload] of [
      ['manual-recognition', { recognition: '人工文本' }],
      ['manual-callsign', { callsign: 'BG5BBB' }],
      ['manual-callee-callsign', { callsign: 'BG5CCC' }],
    ] as const) {
      const response = await app.inject({ headers, method: 'PATCH', payload, url: `/api/admin/records/${segment.id}/${endpoint}` })
      assert.equal(response.statusCode, role === 'editor' ? 200 : 403)
    }
    const review = await app.inject({ headers, method: 'PATCH', payload: { reviewed: true }, url: `/api/admin/records/${segment.id}/manual-review` })
    assert.equal(review.statusCode, 403)
    assert.equal((await app.inject({ headers, method: 'DELETE', url: `/api/admin/records/${segment.id}` })).statusCode, 403)
    assert.equal(repository.find(segment.id)?.reviewed, false)
    assert.equal(existsSync(wav), true)
  }
  const administrator = { cookie: `admin_token=${await auth.login('admin', 'secret')}` }
  const editor = { cookie: `admin_token=${await auth.login('editor', 'secret')}` }
  const reviewUrl = `/api/admin/records/${segment.id}/manual-review`
  assert.equal((await app.inject({ headers: administrator, method: 'PATCH', payload: { reviewed: true }, url: reviewUrl })).statusCode, 200)
  const locked = repository.find(segment.id)
  const edits = [
    ['manual-recognition', { recognition: '已标注后尝试编辑' }],
    ['manual-callsign', { callsign: 'BG5DDD' }],
    ['manual-callee-callsign', { callsign: 'BG5EEE' }],
  ] as const
  for (const [endpoint, payload] of edits) {
    const response = await app.inject({ headers: editor, method: 'PATCH', payload, url: `/api/admin/records/${segment.id}/${endpoint}` })
    assert.equal(response.statusCode, 403)
    assert.equal(response.json().message, '记录已标注，只有管理员可以编辑')
  }
  assert.deepEqual(repository.find(segment.id), locked)
  for (const [endpoint, payload] of edits)
    assert.equal((await app.inject({ headers: administrator, method: 'PATCH', payload, url: `/api/admin/records/${segment.id}/${endpoint}` })).statusCode, 200)
  assert.equal(repository.find(segment.id)?.reviewed, true)
  assert.equal((await app.inject({ headers: administrator, method: 'PATCH', payload: { reviewed: false }, url: reviewUrl })).statusCode, 200)
  for (const [endpoint, payload] of edits)
    assert.equal((await app.inject({ headers: editor, method: 'PATCH', payload, url: `/api/admin/records/${segment.id}/${endpoint}` })).statusCode, 200)
})
