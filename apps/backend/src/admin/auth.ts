import { Buffer } from 'node:buffer'
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

interface AdminUser {
  passwordHash: string
  username: string
}

interface StoredSession {
  expiresAt: string
  tokenHash: string
  username: string
}

interface SessionFile {
  sessions: StoredSession[]
}

const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000

export class AdminAuth {
  static readonly sessionMaxAgeSeconds = SESSION_MAX_AGE_MS / 1_000
  private readonly sessions = new Map<string, StoredSession>()
  private readonly users: AdminUser[]

  constructor(
    usersFile: string,
    private readonly sessionsFile: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.users = parseUsers(readFileSync(usersFile, 'utf8'))
    this.loadSessions()
  }

  login(username: string, password: string): string | undefined {
    this.removeExpiredSessions()
    const user = this.users.find(candidate => candidate.username === username)
    if (!user || !verifyPassword(password, user.passwordHash))
      return undefined
    const token = randomBytes(32).toString('base64url')
    const session: StoredSession = {
      expiresAt: new Date(this.now().getTime() + SESSION_MAX_AGE_MS).toISOString(),
      tokenHash: hashToken(token),
      username,
    }
    this.sessions.set(session.tokenHash, session)
    this.persistSessions()
    return token
  }

  logout(token: string | undefined): void {
    this.removeExpiredSessions()
    if (token && this.sessions.delete(hashToken(token)))
      this.persistSessions()
  }

  isAuthenticated(token: string | undefined): boolean {
    this.removeExpiredSessions()
    return token !== undefined && this.sessions.has(hashToken(token))
  }

  private loadSessions(): void {
    let text: string
    try {
      text = readFileSync(this.sessionsFile, 'utf8')
    }
    catch (error) {
      if (isMissingFile(error)) {
        this.persistSessions()
        return
      }
      throw error
    }
    const { sessions } = parseSessionFile(text)
    for (const session of sessions)
      this.sessions.set(session.tokenHash, session)
    this.removeExpiredSessions()
  }

  private removeExpiredSessions(): void {
    const now = this.now().getTime()
    let changed = false
    for (const [tokenHash, session] of this.sessions) {
      if (Date.parse(session.expiresAt) <= now) {
        this.sessions.delete(tokenHash)
        changed = true
      }
    }
    if (changed)
      this.persistSessions()
  }

  private persistSessions(): void {
    mkdirSync(dirname(this.sessionsFile), { recursive: true })
    const temporaryFile = `${this.sessionsFile}.tmp`
    const content = JSON.stringify({ sessions: [...this.sessions.values()] }, undefined, 2).concat('\n')
    writeFileSync(temporaryFile, content, { mode: 0o600 })
    renameSync(temporaryFile, this.sessionsFile)
  }
}

export function hashPassword(password: string, salt: Buffer = randomBytes(16)): string {
  if (password.length === 0)
    throw new Error('Password cannot be empty')
  const derived = scryptSync(password, salt, 32)
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`
}

function parseUsers(text: string): AdminUser[] {
  const parsed = JSON.parse(text) as unknown
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { users?: unknown }).users))
    throw new Error('admin.json must contain a users array')
  const users = (parsed as { users: unknown[] }).users.map((value) => {
    if (typeof value !== 'object' || value === null)
      throw new Error('admin.json contains an invalid user')
    const { passwordHash, username } = value as Record<string, unknown>
    if (typeof username !== 'string' || username.length === 0 || typeof passwordHash !== 'string')
      throw new Error('admin.json user requires username and passwordHash')
    return { passwordHash, username }
  })
  if (users.length === 0)
    throw new Error('admin.json must contain at least one user')
  return users
}

function parseSessionFile(text: string): SessionFile {
  const parsed = JSON.parse(text) as unknown
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { sessions?: unknown }).sessions))
    throw new Error('sessions.json must contain a sessions array')
  const sessions = (parsed as { sessions: unknown[] }).sessions.map((value) => {
    if (typeof value !== 'object' || value === null)
      throw new Error('sessions.json contains an invalid session')
    const { expiresAt, tokenHash, username } = value as Record<string, unknown>
    if (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt))
      || typeof tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(tokenHash)
      || typeof username !== 'string' || username.length === 0) {
      throw new Error('sessions.json session is invalid')
    }
    return { expiresAt, tokenHash, username }
  })
  return { sessions }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
}

function verifyPassword(password: string, encoded: string): boolean {
  const [kind, saltText, expectedText] = encoded.split('$')
  if (kind !== 'scrypt' || !saltText || !expectedText)
    return false
  try {
    const expected = Buffer.from(expectedText, 'base64')
    const actual = scryptSync(password, Buffer.from(saltText, 'base64'), expected.length)
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  }
  catch {
    return false
  }
}
