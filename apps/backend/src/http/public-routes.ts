import type { FastifyInstance } from 'fastify'
import type { StatsCache } from '../records/stats-cache.js'

interface PublicRoutesOptions {
  getHealth: () => { allmon3: boolean, nats: boolean }
  stats?: Pick<StatsCache, 'get'>
}

export async function registerPublicRoutes(app: FastifyInstance, options: PublicRoutesOptions): Promise<void> {
  app.get('/healthz', async () => ({ ...options.getHealth(), ok: true }))

  app.get('/api/stats', async (_request, reply) => {
    reply.header('cache-control', 'no-store')
    if (!options.stats)
      return reply.code(404).send({ message: '语音记录未启用' })
    try {
      return reply.send(await options.stats.get())
    }
    catch {
      return reply.code(503).send({ message: '统计暂不可用' })
    }
  })
}
