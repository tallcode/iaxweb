import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Fastify from 'fastify'
import { registerNotFoundHandler } from '../../src/http/not-found.js'
import { registerStaticRoutes } from '../../src/http/static-routes.js'

function createApp(context: TestContext) {
  const app = Fastify()
  context.after(() => app.close())
  registerNotFoundHandler(app)
  return app
}

test('serves an HTML 404 for browser navigation with a link to the home page', async (context) => {
  const app = createApp(context)
  for (const url of ['/s', '/s?from=browser', '/apiary', '/assets-other', '/admin/assets-other']) {
    const response = await app.inject({ headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' }, url })
    assert.equal(response.statusCode, 404)
    assert.match(String(response.headers['content-type']), /^text\/html\b/)
    assert.match(response.body, /404/)
    assert.match(response.body, /href="\/"/)
    assert.equal(response.headers['cache-control'], 'no-store')
    assert.ok(String(response.headers.vary).toLowerCase().split(',').map(value => value.trim()).includes('accept'))
  }

  const head = await app.inject({ headers: { accept: 'text/html' }, method: 'HEAD', url: '/s' })
  assert.equal(head.statusCode, 404)
  assert.match(String(head.headers['content-type']), /^text\/html\b/)
  assert.equal(head.body, '')
  assert.equal(head.headers['cache-control'], 'no-store')
})

test('keeps missing API and asset routes as JSON even when the browser accepts HTML', async (context) => {
  const app = createApp(context)
  await app.register(async (admin) => {
    admin.get('/known', async () => ({ ok: true }))
  }, { prefix: '/api/admin' })

  for (const url of ['/api', '/api/missing', '/api/admin/missing?from=browser', '/assets', '/admin/assets']) {
    const response = await app.inject({ headers: { accept: 'text/html' }, url })
    assert.equal(response.statusCode, 404)
    assert.match(String(response.headers['content-type']), /^application\/json\b/)
    assert.deepEqual(response.json(), { message: `Route GET:${url} not found`, error: 'Not Found', statusCode: 404 })
  }
  const known = await app.inject({ headers: { accept: 'text/html' }, url: '/api/admin/known' })
  assert.equal(known.statusCode, 200)
  assert.deepEqual(known.json(), { ok: true })
})

test('keeps non-document requests and unacceptable HTML qualities as JSON', async (context) => {
  const app = createApp(context)
  for (const accept of [undefined, 'application/json', 'text/plain', '*/*', 'text/html;q=0', 'text/html;q=0.000', 'text/html;q=1.1', 'text/html;q=-1', 'text/html;q=invalid']) {
    const response = await app.inject({ ...(accept ? { headers: { accept } } : {}), url: '/s' })
    assert.equal(response.statusCode, 404)
    assert.match(String(response.headers['content-type']), /^application\/json\b/)
    assert.deepEqual(response.json(), { message: 'Route GET:/s not found', error: 'Not Found', statusCode: 404 })
  }
  for (const method of ['POST', 'DELETE'] as const) {
    const response = await app.inject({ headers: { accept: 'text/html' }, method, url: '/s?method=other' })
    assert.equal(response.statusCode, 404)
    assert.match(String(response.headers['content-type']), /^application\/json\b/)
    assert.deepEqual(response.json(), { message: `Route ${method}:/s?method=other not found`, error: 'Not Found', statusCode: 404 })
  }
  for (const accept of ['text/html;q=0.5', 'application/json, text/html; charset=utf-8; q=1', 'TEXT/HTML; Q=0.8']) {
    const response = await app.inject({ headers: { accept }, url: '/s' })
    assert.equal(response.statusCode, 404)
    assert.match(String(response.headers['content-type']), /^text\/html\b/)
  }
})

test('preserves existing pages and assets while returning JSON for missing asset files', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'iaxweb-not-found-'))
  context.after(() => rmSync(directory, { force: true, recursive: true }))
  const publicRoot = join(directory, 'public')
  const adminRoot = join(directory, 'admin')
  mkdirSync(join(publicRoot, 'assets'), { recursive: true })
  mkdirSync(join(adminRoot, 'assets'), { recursive: true })
  writeFileSync(join(publicRoot, 'index.html'), '<html><head></head><body>public app</body></html>')
  writeFileSync(join(adminRoot, 'index.html'), '<html><head></head><body>admin app</body></html>')
  writeFileSync(join(publicRoot, 'assets', 'app.js'), 'public asset')
  writeFileSync(join(adminRoot, 'assets', 'app.js'), 'admin asset')
  const app = createApp(context)
  await app.register(registerStaticRoutes, { adminRoot, nodeDefinitions: {}, publicRoot })

  for (const url of ['/', '/topology', '/map', '/stats']) {
    const response = await app.inject({ headers: { accept: 'text/html' }, url })
    assert.equal(response.statusCode, 200)
    assert.match(response.body, /public app/)
  }
  const admin = await app.inject({ headers: { accept: 'text/html' }, url: '/admin/records' })
  assert.equal(admin.statusCode, 200)
  assert.match(admin.body, /admin app/)
  assert.equal((await app.inject('/assets/app.js')).body, 'public asset')
  assert.equal((await app.inject('/admin/assets/app.js')).body, 'admin asset')

  for (const url of ['/assets/missing.js', '/admin/assets/missing.js']) {
    const response = await app.inject({ headers: { accept: 'text/html' }, url })
    assert.equal(response.statusCode, 404)
    assert.match(String(response.headers['content-type']), /^application\/json\b/)
    assert.deepEqual(response.json(), { message: `Route GET:${url} not found`, error: 'Not Found', statusCode: 404 })
  }
  const missing = await app.inject({ headers: { accept: 'text/html' }, url: '/s' })
  assert.equal(missing.statusCode, 404)
  assert.match(String(missing.headers['content-type']), /^text\/html\b/)
})
