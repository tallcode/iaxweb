import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fastifyStatic from '@fastify/static'

interface StaticRoutesOptions {
  adminRoot: string
  publicRoot: string
}

interface WildcardParams {
  '*': string
}

export async function registerStaticRoutes(app: FastifyInstance, options: StaticRoutesOptions): Promise<void> {
  await app.register(fastifyStatic, {
    root: options.publicRoot,
    serve: false,
  })

  const sendPublicIndex = async (_request: FastifyRequest, reply: FastifyReply) =>
    reply.header('cache-control', 'no-cache').sendFile('index.html', options.publicRoot)

  app.get('/', sendPublicIndex)
  app.get('/map', sendPublicIndex)
  app.get('/map/', sendPublicIndex)

  app.get<{ Params: WildcardParams }>('/assets/*', async (request, reply) =>
    reply.header('cache-control', 'no-cache').sendFile(`assets/${request.params['*']}`, options.publicRoot))

  app.get<{ Params: WildcardParams }>('/admin/assets/*', async (request, reply) =>
    reply.header('cache-control', 'no-cache').sendFile(`assets/${request.params['*']}`, options.adminRoot))

  const sendAdminIndex = async (_request: FastifyRequest, reply: FastifyReply) =>
    reply.header('cache-control', 'no-cache').sendFile('index.html', options.adminRoot)

  app.get('/admin', sendAdminIndex)
  app.get('/admin/', sendAdminIndex)
  app.get('/admin/*', sendAdminIndex)
}
