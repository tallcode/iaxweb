import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { NodeDefinitions } from '../allmon3/types.js'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import fastifyStatic from '@fastify/static'

interface StaticRoutesOptions {
  adminRoot: string
  nodeDefinitions: NodeDefinitions
  publicRoot: string
  publicSiteUrl?: string
}

interface WildcardParams {
  '*': string
}

interface StaticDocument {
  content: string
  contentType: string
  etag: string
}

const PUBLIC_PAGES: ReadonlyArray<{
  path: string
  aliases: readonly string[]
  title: string
  description: string
}> = [
  {
    path: '/',
    aliases: ['/topology', '/topology/'],
    title: '浙江业余无线电中继台实时状态与在线收听',
    description: '实时查看浙江省业余无线电中继台(BR5AI，BR5BB，BR5AF，BR5AO，BR5AR)的在线状态、连接拓扑、工作频率及发射状态，支持中继音频在线收听。',
  },
  {
    path: '/map',
    aliases: ['/map/'],
    title: '浙江业余无线电中继台地图与覆盖预测',
    description: '在地图上查看浙江业余无线电中继台的位置、在线和发射状态。可切换 BR5AI、BR5BB、BR5AF 和 BR5AO 的预测覆盖图层，查看不同信号强度的分布。',
  },
  {
    path: '/stats',
    aliases: ['/stats/'],
    title: '浙江业余无线电中继台通联统计',
    description: '查看联网到杭州 Hub 期间的通联统计，包括最近 30 天及当天的每日语音条数和累计通联时长，以及最近 4 周的 24 小时活跃分布和按星期及小时划分的热力图。',
  },
]

const DOCUMENT_CACHE_CONTROL = 'public, max-age=0, must-revalidate'
const REQUEST_DOCUMENT_CACHE_CONTROL = 'private, max-age=0, must-revalidate'
const ONE_YEAR_MS = 31_536_000_000

export async function registerStaticRoutes(app: FastifyInstance, options: StaticRoutesOptions): Promise<void> {
  await app.register(fastifyStatic, {
    root: options.publicRoot,
    serve: false,
  })

  const publicIndex = readFileSync(join(options.publicRoot, 'index.html'), 'utf8')
  const siteUrl = options.publicSiteUrl
  for (const page of PUBLIC_PAGES) {
    const html = replacePageMetadata(publicIndex, page.title, page.description)
    const aliases = publicPageHandler(siteUrl, page.path, html)
    const primary = page.path === '/' ? publicPageHandler(siteUrl, page.path, injectRepeaterMetadata(html, options.nodeDefinitions)) : aliases
    app.get(page.path, primary)
    for (const alias of page.aliases)
      app.get(alias, aliases)
  }

  app.get('/sitemap.xml', siteDocumentHandler(siteUrl, origin => origin ? sitemapDocument(origin) : undefined))
  app.get('/robots.txt', siteDocumentHandler(siteUrl, origin => origin
    ? createDocument(`User-agent: *\nSitemap: ${new URL('/sitemap.xml', origin).href}\n`, 'text/plain; charset=utf-8')
    : undefined))

  app.get<{ Params: WildcardParams }>('/assets/*', async (request, reply) =>
    reply.sendFile(`assets/${request.params['*']}`, options.publicRoot, { immutable: true, maxAge: ONE_YEAR_MS }))

  app.get<{ Params: WildcardParams }>('/admin/assets/*', async (request, reply) =>
    reply.sendFile(`assets/${request.params['*']}`, options.adminRoot, { immutable: true, maxAge: ONE_YEAR_MS }))

  const adminIndex = readFileSync(join(options.adminRoot, 'index.html'), 'utf8')
  const adminDocument = createDocument(adminIndex)
  const sendAdminIndex = (request: FastifyRequest, reply: FastifyReply) => sendDocument(request, reply, adminDocument)

  app.get('/admin', sendAdminIndex)
  app.get('/admin/', sendAdminIndex)
  app.get('/admin/*', sendAdminIndex)
}

function requestSiteUrl(request: FastifyRequest): string | undefined {
  const host = request.host
  if (!/^(?:[\w.-]+|\[[\da-f:.]+\])(?::\d+)?$/i.test(host))
    return undefined
  const forwardedProto = request.headers['x-forwarded-proto']
  const protocol = (Array.isArray(forwardedProto) ? forwardedProto.at(-1) : forwardedProto)?.split(',').at(-1)?.trim().toLowerCase()
  const scheme = protocol === 'https' || protocol === 'http' ? protocol : request.protocol
  return URL.parse(`${scheme}://${host}`)?.origin
}

function siteDocumentHandler(siteUrl: string | undefined, render: (origin: string | undefined) => StaticDocument | undefined) {
  const fixedDocument = siteUrl ? render(siteUrl) : undefined
  return (request: FastifyRequest, reply: FastifyReply): FastifyReply => {
    if (fixedDocument)
      return sendDocument(request, reply, fixedDocument)

    const document = render(requestSiteUrl(request))
    if (!document)
      return reply.header('cache-control', 'no-store').code(400).send('Invalid request host')
    // Request-derived URLs must not be stored in shared caches.
    return sendDocument(request, reply, document, REQUEST_DOCUMENT_CACHE_CONTROL)
  }
}

function publicPageHandler(siteUrl: string | undefined, path: string, html: string) {
  return siteDocumentHandler(siteUrl, origin => createDocument(origin
    ? appendToHead(html, `<link rel="canonical" href="${escapeMarkup(new URL(path, origin).href)}">`)
    : html))
}

function sitemapDocument(origin: string): StaticDocument {
  return createDocument([
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...PUBLIC_PAGES.map(page => `  <url><loc>${escapeMarkup(new URL(page.path, origin).href)}</loc></url>`),
    '</urlset>',
    '',
  ].join('\n'), 'application/xml; charset=utf-8')
}

function sendDocument(request: FastifyRequest, reply: FastifyReply, document: StaticDocument, cacheControl = DOCUMENT_CACHE_CONTROL): FastifyReply {
  reply.header('cache-control', cacheControl).header('etag', document.etag)
  if (matchesEtag(request.headers['if-none-match'], document.etag))
    return reply.code(304).send()
  return reply.type(document.contentType).send(document.content)
}

function createDocument(content: string, contentType = 'text/html; charset=utf-8'): StaticDocument {
  return { content, contentType, etag: createEtag(content) }
}

function createEtag(content: string): string {
  return `"${createHash('sha256').update(content).digest('base64url')}"`
}

function matchesEtag(value: string | undefined, etag: string): boolean {
  return value?.split(',').some(candidate => candidate.trim() === '*' || candidate.trim() === etag) ?? false
}

function replacePageMetadata(html: string, title: string, description: string): string {
  const cleaned = html.replace(/<title>[^<]*<\/title>/i, '').replace(/<meta\s+name="description"[^>]*>/i, '')
  return appendToHead(cleaned, `<title>${escapeMarkup(title)}</title>\n  <meta name="description" content="${escapeMarkup(description)}">`)
}

function appendToHead(html: string, markup: string): string {
  return html.replace('</head>', () => `  ${markup}\n  </head>`)
}

function escapeMarkup(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function injectRepeaterMetadata(html: string, definitions: NodeDefinitions): string {
  const itemListElement = Object.entries(definitions)
    .filter(([, definition]) => definition.TYPE === 'REPEATER')
    .map(([nodeId, definition]) => ({
      '@type': 'Thing',
      'name': definition.NAME?.trim() || `节点 ${nodeId}`,
      'description': describeRepeaterFrequency(definition.FREQ),
    }))
  if (itemListElement.length === 0)
    return html

  const metadata = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    'name': '浙江业余无线电中继台',
    itemListElement,
  }).replaceAll('<', '\\u003c')
  return appendToHead(html, `<script type="application/ld+json">${metadata}</script>`)
}

function describeRepeaterFrequency(value = ''): string {
  const [frequency, offset, ...tones] = value
    .replace(/(\d)(MHz|Hz)\b/gi, '$1 $2')
    .replace(/\b(TSQ|CTCSS|DCS)(?=\d)/gi, '$1 ')
    .split('/')
    .map(field => field.trim())

  return `频率 ${frequency || '未配置'}，频差 ${offset || '未配置'}，亚音 ${tones.filter(Boolean).join('/') || '未配置'}`
}
