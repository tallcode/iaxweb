import type { FastifyInstance } from 'fastify'
import type { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

interface CoverageOptions {
  directory: string
}

interface CoverageParams {
  callsign: string
}

const COVERAGE_CACHE_CONTROL = 'public, max-age=2592000, immutable, no-transform'

export async function registerCoverageRoutes(app: FastifyInstance, { directory }: CoverageOptions): Promise<void> {
  app.get<{ Params: CoverageParams }>('/api/coverage/:callsign.geojson', { compress: false }, async (request, reply) => {
    reply.header('vary', 'Accept-Encoding').header('cache-control', 'no-store')
    if (!acceptsGzip(request.headers['accept-encoding']))
      return reply.code(406).send({ message: '覆盖图层需要客户端支持 gzip' })

    const { callsign } = request.params
    if (!/^[A-Z0-9][\w-]{0,31}$/i.test(callsign))
      return reply.code(404).send({ message: '覆盖图层不存在' })

    let content: Buffer
    try {
      content = await readFile(join(directory, `${callsign.toUpperCase()}.geojson.gz`))
    }
    catch (error) {
      if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'EISDIR'))
        return reply.code(404).send({ message: '覆盖图层不存在' })
      throw error
    }

    return reply.type('application/geo+json')
      .header('content-encoding', 'gzip')
      .header('cache-control', COVERAGE_CACHE_CONTROL)
      .send(content)
  })
}

function acceptsGzip(header: string | undefined): boolean {
  let wildcard = false
  for (const entry of header?.toLowerCase().split(',') ?? []) {
    const [encoding, ...parameters] = entry.split(';').map(part => part.trim())
    if (encoding !== 'gzip' && encoding !== '*')
      continue
    const quality = parameters.find(parameter => /^q\s*=/.test(parameter))
    const value = quality?.replace(/^q\s*=\s*/, '')
    const accepted = value === undefined || (/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(value) && Number(value) > 0)
    if (encoding === 'gzip')
      return accepted
    wildcard = accepted
  }
  return wildcard
}
