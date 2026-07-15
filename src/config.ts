import process from 'node:process'

export interface Config {
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

  return {
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
