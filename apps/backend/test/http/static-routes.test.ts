import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import fastifyCompress from '@fastify/compress'
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
  await app.register(fastifyCompress)
  await app.register(registerStaticRoutes, {
    adminRoot,
    publicRoot,
  })

  const publicResponse = await app.inject('/')
  const publicIndex = publicResponse.body
  assert.doesNotMatch(publicIndex, /application\/ld\+json/)
  assert.equal(publicResponse.headers['cache-control'], 'public, max-age=0, must-revalidate')
  assert.ok(publicResponse.headers.etag)
  const notModified = await app.inject({
    headers: { 'if-none-match': publicResponse.headers.etag },
    url: '/',
  })
  assert.equal(notModified.statusCode, 304)
  assert.equal(notModified.body, '')
  assert.equal((await app.inject('/map')).body, publicIndex)
  assert.equal((await app.inject('/topology')).body, publicIndex)
  assert.equal((await app.inject('/admin/reviews/one')).body, 'admin app')
  const publicAsset = await app.inject('/assets/app.js')
  assert.equal(publicAsset.body, 'public asset')
  assert.equal(publicAsset.headers['cache-control'], 'public, max-age=31536000, immutable')
  const compressedPublicAsset = await app.inject({
    headers: { 'accept-encoding': 'gzip' },
    url: '/assets/app.js',
  })
  assert.equal(compressedPublicAsset.headers['content-encoding'], 'gzip')
  assert.equal(compressedPublicAsset.headers.vary, 'accept-encoding')
  assert.equal(gunzipSync(compressedPublicAsset.rawPayload).toString(), 'public asset')
  const brotliPublicAsset = await app.inject({
    headers: { 'accept-encoding': 'br' },
    url: '/assets/app.js',
  })
  assert.equal(brotliPublicAsset.headers['content-encoding'], 'br')
  assert.equal(brotliDecompressSync(brotliPublicAsset.rawPayload).toString(), 'public asset')
  const adminAsset = await app.inject('/admin/assets/app.js')
  assert.equal(adminAsset.body, 'admin asset')
  assert.equal(adminAsset.headers['cache-control'], 'public, max-age=31536000, immutable')
  assert.equal((await app.inject('/missing')).statusCode, 404)
})
