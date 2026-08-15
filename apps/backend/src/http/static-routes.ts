import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import fastifyStatic from '@fastify/static'

interface StaticRoutesOptions {
  adminRoot: string
  publicRoot: string
}

interface WildcardParams {
  '*': string
}

interface HtmlDocument {
  content: string
  etag: string
}

const HTML_CACHE_CONTROL = 'public, max-age=0, must-revalidate'
const ONE_YEAR_MS = 31_536_000_000

export async function registerStaticRoutes(app: FastifyInstance, options: StaticRoutesOptions): Promise<void> {
  await app.register(fastifyStatic, {
    root: options.publicRoot,
    serve: false,
  })

  const publicIndex = readFileSync(join(options.publicRoot, 'index.html'), 'utf8')
  const publicDocument = createHtmlDocument(publicIndex)
  const sendPublicIndex = (request: FastifyRequest, reply: FastifyReply) =>
    sendHtml(request, reply, publicDocument)

  app.get('/', sendPublicIndex)
  app.get('/map', sendPublicIndex)
  app.get('/map/', sendPublicIndex)

  app.get<{ Params: WildcardParams }>('/assets/*', async (request, reply) =>
    reply.sendFile(`assets/${request.params['*']}`, options.publicRoot, { immutable: true, maxAge: ONE_YEAR_MS }))

  app.get<{ Params: WildcardParams }>('/admin/assets/*', async (request, reply) =>
    reply.sendFile(`assets/${request.params['*']}`, options.adminRoot, { immutable: true, maxAge: ONE_YEAR_MS }))

  const adminIndex = readFileSync(join(options.adminRoot, 'index.html'), 'utf8')
  const adminDocument = createHtmlDocument(adminIndex)
  const sendAdminIndex = (request: FastifyRequest, reply: FastifyReply) => sendHtml(request, reply, adminDocument)

  app.get('/admin', sendAdminIndex)
  app.get('/admin/', sendAdminIndex)
  app.get('/admin/*', sendAdminIndex)
}

function sendHtml(request: FastifyRequest, reply: FastifyReply, document: HtmlDocument): FastifyReply {
  reply.header('cache-control', HTML_CACHE_CONTROL).header('etag', document.etag)
  if (matchesEtag(request.headers['if-none-match'], document.etag))
    return reply.code(304).send()
  return reply.type('text/html; charset=utf-8').send(document.content)
}

function createHtmlDocument(content: string): HtmlDocument {
  return { content, etag: createEtag(content) }
}

function createEtag(content: string): string {
  return `"${createHash('sha256').update(content).digest('base64url')}"`
}

function matchesEtag(value: string | undefined, etag: string): boolean {
  return value?.split(',').some(candidate => candidate.trim() === '*' || candidate.trim() === etag) ?? false
}
