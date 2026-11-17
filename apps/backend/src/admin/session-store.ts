import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

interface StoredSession { expiresAt: string, tokenHash: string, username: string }
interface SessionFile { sessions: StoredSession[] }
export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000

export class SessionStore {
  private readonly sessions = new Map<string, StoredSession>()

  constructor(private readonly sessionsFile: string, private readonly now: () => Date) {
    this.loadSessions()
  }

  create(username: string): string {
    this.removeExpiredSessions()
    const token = randomBytes(32).toString('base64url')
    const session = { username, tokenHash: hashToken(token), expiresAt: new Date(this.now().getTime() + SESSION_MAX_AGE_MS).toISOString() }
    this.sessions.set(session.tokenHash, session)
    this.persistSessions()
    return token
  }

  getUsername(token: string | undefined): string | undefined {
    this.removeExpiredSessions()
    return token === undefined ? undefined : this.sessions.get(hashToken(token))?.username
  }

  logout(token: string | undefined): void {
    this.removeExpiredSessions()
    if (token && this.sessions.delete(hashToken(token)))
      this.persistSessions()
  }

  revokeUserSessions(username: string): void {
    let changed = false
    for (const [key, session] of this.sessions) {
      if (session.username === username) {
        this.sessions.delete(key)
        changed = true
      }
    }
    if (changed)
      this.persistSessions()
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

  removeExpiredSessions(): void {
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
