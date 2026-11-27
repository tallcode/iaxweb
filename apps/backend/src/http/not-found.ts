import type { FastifyInstance } from 'fastify'
import { readFileSync } from 'node:fs'

const notFoundPage = readFileSync(new URL('./not-found.html', import.meta.url), 'utf8')

export function registerNotFoundHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0] ?? '/'
    const resource = ['/api', '/assets', '/admin/assets'].some(prefix => path === prefix || path.startsWith(`${prefix}/`))
    reply.code(404).header('cache-control', 'no-store').header('vary', 'Accept')
    if ((request.method === 'GET' || request.method === 'HEAD') && !resource && acceptsHtml(request.headers.accept))
      return reply.type('text/html; charset=utf-8').send(notFoundPage)

    return reply.send({
      message: `Route ${request.method}:${request.url} not found`,
      error: 'Not Found',
      statusCode: 404,
    })
  })
}

function acceptsHtml(accept = ''): boolean {
  return accept.toLowerCase().split(',').some((entry) => {
    const [type, ...parameters] = entry.split(';').map(value => value.trim())
    const quality = parameters.find(parameter => /^q\s*=/.test(parameter))?.split('=')[1]
    return type === 'text/html' && (quality === undefined || (Number(quality) > 0 && Number(quality) <= 1))
  })
}
