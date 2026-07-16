import process from 'node:process'

export interface Config {
  allmon3: {
    baseUrl: string
    refreshIntervalMs: number
    requestTimeoutMs: number
  }
  host: string
  port: number
  nats: {
    servers: string[]
    subjectPrefix: string
    username?: string
    password?: string
    token?: string
  }
}

const invalidSubjectToken = /[\s*>]/

function optional(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim()
  return value || undefined
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const portText = optional(env, 'PORT') ?? '3000'
  const port = Number(portText)
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error(`PORT must be an integer between 1 and 65535, got: ${portText}`)

  const servers = (optional(env, 'NATS_SERVERS') ?? 'nats://127.0.0.1:4222')
    .split(',')
    .map(server => server.trim())
    .filter(Boolean)
  if (servers.length === 0)
    throw new Error('NATS_SERVERS must contain at least one server URL')

  const subjectPrefix = optional(env, 'NATS_SUBJECT_PREFIX') ?? 'iaxmon.nodes.1999'
  if (subjectPrefix.startsWith('.') || subjectPrefix.endsWith('.') || invalidSubjectToken.test(subjectPrefix))
    throw new Error('NATS_SUBJECT_PREFIX is not a valid subject root')

  const username = optional(env, 'NATS_USERNAME')
  const password = optional(env, 'NATS_PASSWORD')
  const token = optional(env, 'NATS_TOKEN')

  if (Boolean(username) !== Boolean(password))
    throw new Error('NATS_USERNAME and NATS_PASSWORD must be set together')
  if (token && username)
    throw new Error('NATS_TOKEN cannot be combined with NATS_USERNAME/NATS_PASSWORD')

  const allmon3BaseUrl = optional(env, 'ALLMON3_BASE_URL') ?? 'http://172.16.211.199/allmon3/'
  const parsedAllmon3Url = new URL(allmon3BaseUrl)
  if (!['http:', 'https:'].includes(parsedAllmon3Url.protocol))
    throw new Error('ALLMON3_BASE_URL must use http or https')
  if (!parsedAllmon3Url.pathname.endsWith('/'))
    parsedAllmon3Url.pathname += '/'

  const refreshIntervalMs = parsePositiveInteger(
    optional(env, 'ALLMON3_REFRESH_INTERVAL_MS') ?? '30000',
    'ALLMON3_REFRESH_INTERVAL_MS',
  )
  const requestTimeoutMs = parsePositiveInteger(
    optional(env, 'ALLMON3_REQUEST_TIMEOUT_MS') ?? '10000',
    'ALLMON3_REQUEST_TIMEOUT_MS',
  )

  return {
    allmon3: {
      baseUrl: parsedAllmon3Url.toString(),
      refreshIntervalMs,
      requestTimeoutMs,
    },
    host: optional(env, 'HOST') ?? '0.0.0.0',
    port,
    nats: {
      servers,
      subjectPrefix,
      ...(username && password ? { username, password } : {}),
      ...(token ? { token } : {}),
    },
  }
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`${name} must be a positive integer, got: ${value}`)
  return parsed
}
