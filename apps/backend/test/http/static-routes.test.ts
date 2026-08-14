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
  writeFileSync(join(publicRoot, 'index.html'), '<html><head></head><body>public app</body></html>')
  writeFileSync(join(adminRoot, 'index.html'), 'admin app')
  writeFileSync(join(publicRoot, 'assets', 'app.js'), 'public asset')
  writeFileSync(join(adminRoot, 'assets', 'app.js'), 'admin asset')

  const app = Fastify()
  context.after(() => app.close())
  await app.register(registerStaticRoutes, {
    adminRoot,
    nodeDefinitions: {
      hub: { NAME: '浙江 HUB', TYPE: 'HUB' },
      repeater: { FREQ: '145.400MHz/-0.6MHz/TSQ88.5Hz', NAME: 'BR5AI', TYPE: 'REPEATER' },
    },
    publicRoot,
  })

  const publicResponse = await app.inject('/')
  const publicIndex = publicResponse.body
  assert.match(publicIndex, /<script type="application\/ld\+json">/)
  assert.match(publicIndex, /"name":"BR5AI"/)
  assert.match(publicIndex, /"value":"145\.400MHz\/-0\.6MHz\/TSQ88\.5Hz"/)
  assert.doesNotMatch(publicIndex, /浙江 HUB/)
  assert.equal(publicResponse.headers['cache-control'], 'public, max-age=0, must-revalidate')
  assert.ok(publicResponse.headers.etag)
  const notModified = await app.inject({
    headers: { 'if-none-match': publicResponse.headers.etag },
    url: '/',
  })
  assert.equal(notModified.statusCode, 304)
  assert.equal(notModified.body, '')
  assert.equal((await app.inject('/map')).body, publicIndex)
  assert.equal((await app.inject('/admin/reviews/one')).body, 'admin app')
  const publicAsset = await app.inject('/assets/app.js')
  assert.equal(publicAsset.body, 'public asset')
  assert.equal(publicAsset.headers['cache-control'], 'public, max-age=31536000, immutable')
  const adminAsset = await app.inject('/admin/assets/app.js')
  assert.equal(adminAsset.body, 'admin asset')
  assert.equal(adminAsset.headers['cache-control'], 'public, max-age=31536000, immutable')
  assert.equal((await app.inject('/missing')).statusCode, 404)
})
