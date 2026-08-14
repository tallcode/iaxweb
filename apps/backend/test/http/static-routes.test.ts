import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Fastify from 'fastify'
import { registerStaticRoutes } from '../../src/http/static-routes.js'

test('serves both Fastify-hosted SPAs and keeps their assets isolated', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'iaxweb-fastify-static-'))
  context.after(() => rmSync(directory, { force: true, recursive: true }))
  const publicRoot = join(directory, 'public')
  const adminRoot = join(directory, 'admin')
  mkdirSync(join(publicRoot, 'assets'), { recursive: true })
  mkdirSync(join(adminRoot, 'assets'), { recursive: true })
  writeFileSync(join(publicRoot, 'index.html'), 'public app')
  writeFileSync(join(adminRoot, 'index.html'), 'admin app')
  writeFileSync(join(publicRoot, 'assets', 'app.js'), 'public asset')
  writeFileSync(join(adminRoot, 'assets', 'app.js'), 'admin asset')

  const app = Fastify()
  context.after(() => app.close())
  await app.register(registerStaticRoutes, { adminRoot, publicRoot })

  assert.equal((await app.inject('/')).body, 'public app')
  assert.equal((await app.inject('/map')).body, 'public app')
  assert.equal((await app.inject('/admin/reviews/one')).body, 'admin app')
  assert.equal((await app.inject('/assets/app.js')).body, 'public asset')
  assert.equal((await app.inject('/admin/assets/app.js')).body, 'admin asset')
  assert.equal((await app.inject('/missing')).statusCode, 404)
})
