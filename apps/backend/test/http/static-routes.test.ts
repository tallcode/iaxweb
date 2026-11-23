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
  const publicTemplate = '<html><head><title>默认标题</title><meta name="description" content="默认描述"></head><body>public app</body></html>'
  writeFileSync(join(publicRoot, 'index.html'), publicTemplate)
  writeFileSync(join(adminRoot, 'index.html'), 'admin app')
  writeFileSync(join(publicRoot, 'assets', 'app.js'), 'public asset')
  writeFileSync(join(adminRoot, 'assets', 'app.js'), 'admin asset')

  const app = Fastify()
  context.after(() => app.close())
  await app.register(fastifyCompress)
  await app.register(registerStaticRoutes, {
    adminRoot,
    nodeDefinitions: {
      1900: { NAME: '浙江 HUB', TYPE: 'HUB' },
      1901: { FREQ: '145.400MHz/-0.6MHz/TSQ88.5Hz', NAME: 'BR5AI', TYPE: 'REPEATER' },
      1902: { FREQ: '145.480MHz//TSQ107.2Hz', NAME: 'BR5BB </script> $&', TYPE: 'REPEATER' },
      1903: { TYPE: 'REPEATER' },
    },
    publicRoot,
    publicSiteUrl: 'https://radio.example.test',
  })

  const publicResponse = await app.inject('/')
  const publicIndex = publicResponse.body
  const metadata = /<script type="application\/ld\+json">([^<]*)<\/script>/.exec(publicIndex)?.[1]
  assert.ok(metadata)
  assert.ok(publicIndex.indexOf(metadata) < publicIndex.indexOf('</head>'))
  assert.deepEqual(JSON.parse(metadata), {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    'name': '浙江业余无线电中继台',
    'itemListElement': [
      { '@type': 'Thing', 'name': 'BR5AI', 'description': '频率 145.400 MHz，频差 -0.6 MHz，亚音 TSQ 88.5 Hz' },
      { '@type': 'Thing', 'name': 'BR5BB </script> $&', 'description': '频率 145.480 MHz，频差 未配置，亚音 TSQ 107.2 Hz' },
      { '@type': 'Thing', 'name': '节点 1903', 'description': '频率 未配置，频差 未配置，亚音 未配置' },
    ],
  })
  assert.equal(publicIndex.split('</head>')[1], publicTemplate.split('</head>')[1])
  assert.equal(publicResponse.headers['cache-control'], 'public, max-age=0, must-revalidate')
  assert.ok(publicResponse.headers.etag)
  const notModified = await app.inject({
    headers: { 'if-none-match': publicResponse.headers.etag },
    url: '/',
  })
  assert.equal(notModified.statusCode, 304)
  assert.equal(notModified.body, '')
  const sitemap = await app.inject({ headers: { host: 'alias.example.test' }, url: '/sitemap.xml' })
  assert.equal(sitemap.statusCode, 200)
  assert.match(String(sitemap.headers['content-type']), /^application\/xml/)
  assert.deepEqual([...sitemap.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map(entry => entry[1]), [
    'https://radio.example.test/',
    'https://radio.example.test/map',
    'https://radio.example.test/stats',
  ])
  assert.equal((await app.inject('/robots.txt')).body, 'User-agent: *\nSitemap: https://radio.example.test/sitemap.xml\n')
  for (const [route, canonical, title] of [
    ['/', '/', '浙江业余无线电中继台实时状态与在线收听'],
    ['/topology', '/', '浙江业余无线电中继台实时状态与在线收听'],
    ['/map/', '/map', '浙江业余无线电中继台地图与覆盖预测'],
    ['/stats', '/stats', '浙江业余无线电中继台通联统计'],
  ] as const) {
    const response = await app.inject(route)
    assert.ok(response.body.includes(`<link rel="canonical" href="https://radio.example.test${canonical}">`))
    assert.deepEqual([...response.body.matchAll(/<title>([^<]+)<\/title>/g)].map(entry => entry[1]), [title])
    assert.equal([...response.body.matchAll(/name="description"/g)].length, 1)
    assert.ok(!response.body.includes('默认描述'))
    assert.equal(response.body.split('</head>')[1], publicTemplate.split('</head>')[1])
  }
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

  const inferred = Fastify()
  context.after(() => inferred.close())
  await inferred.register(registerStaticRoutes, { adminRoot, nodeDefinitions: {}, publicRoot })
  const direct = await inferred.inject({ headers: { host: 'localhost:8059' }, url: '/sitemap.xml' })
  assert.ok(direct.body.includes('<loc>http://localhost:8059/</loc>'))

  const headers = { 'host': 'radio.example.test', 'x-forwarded-proto': 'https' }
  const proxied = await inferred.inject({ headers, url: '/sitemap.xml' })
  assert.ok(proxied.body.includes('<loc>https://radio.example.test/map</loc>'))
  assert.equal(proxied.headers['cache-control'], 'private, max-age=0, must-revalidate')
  assert.notEqual(proxied.headers.etag, direct.headers.etag)
  assert.ok((await inferred.inject({ headers, url: '/topology' })).body.includes('href="https://radio.example.test/"'))
  assert.ok((await inferred.inject({ headers, url: '/robots.txt' })).body.includes('Sitemap: https://radio.example.test/sitemap.xml'))
})
