import type { AdminRole, AdminSession } from '@iaxweb/contracts'
import { Buffer } from 'node:buffer'
import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

interface AdminUser extends AdminSession {
  passwordHash: string
}

interface StoredSession {
  expiresAt: string
  tokenHash: string
  username: string
}

interface SessionFile {
  sessions: StoredSession[]
}

export interface UserUpdate {
  username?: string
  password?: string
  role?: AdminRole
}

export class UserManagementError extends Error {
  constructor(readonly statusCode: 400 | 404 | 409, message: string) {
    super(message)
  }
}

const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000
const DUMMY_PASSWORD_HASH = hashPassword('invalid-admin-password')

export class AdminAuth {
  static readonly sessionMaxAgeSeconds = SESSION_MAX_AGE_MS / 1_000
  private readonly sessions = new Map<string, StoredSession>()
  private readonly systemUsers: AdminUser[]
  private users: AdminUser[]
  private readonly usersFile: string

  constructor(
    usersFile: string,
    private readonly sessionsFile: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.systemUsers = parseUsers(readFileSync(usersFile, 'utf8'), true)
    this.usersFile = join(dirname(sessionsFile), 'users.json')
    try {
      this.users = parseUsers(readFileSync(this.usersFile, 'utf8'), false)
    }
    catch (error) {
      if (!isMissingFile(error))
        throw error
      this.users = []
      this.persistUsers(this.users)
    }
    if (this.users.some(user => this.systemUsers.some(system => system.username === user.username)))
      throw new Error('users.json must not contain a system account username')
    this.loadSessions()
  }

  async login(username: string, password: string): Promise<string | undefined> {
    this.removeExpiredSessions()
    const user = this.findAccount(username)
    const verified = await verifyPassword(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH)
    if (!user || !verified || this.findAccount(username)?.passwordHash !== user.passwordHash)
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
    return this.getUser(token) !== undefined
  }

  getUser(token: string | undefined): AdminSession | undefined {
    this.removeExpiredSessions()
    const session = token === undefined ? undefined : this.sessions.get(hashToken(token))
    if (!session)
      return undefined
    const system = this.systemUsers.find(candidate => candidate.username === session.username)
    if (system)
      return { role: 'admin', username: system.username, system: true }
    return this.findUser(session.username)
  }

  listUsers(): AdminSession[] {
    return this.users.map(({ username, role }) => ({ username, role }))
  }

  findUser(username: string): AdminSession | undefined {
    const user = this.users.find(candidate => candidate.username === username)
    return user ? { username: user.username, role: user.role } : undefined
  }

  async createUser(username: string, password: string, role: AdminRole): Promise<AdminSession> {
    const name = validateUsername(username)
    const passwordHash = await createPasswordHash(password)
    if (this.findAccount(name))
      throw new UserManagementError(409, '用户名已存在')
    const users = [...this.users, { username: name, role, passwordHash }]
    this.persistUsers(users)
    this.users = users
    return { username: name, role }
  }

  async updateUser(username: string, patch: UserUpdate): Promise<AdminSession> {
    const name = patch.username === undefined ? username : validateUsername(patch.username)
    const passwordHash = patch.password === undefined ? undefined : await createPasswordHash(patch.password)
    const index = this.users.findIndex(user => user.username === username)
    const user = this.users[index]
    if (!user)
      throw new UserManagementError(404, '用户不存在')
    if (name !== username && this.findAccount(name))
      throw new UserManagementError(409, '用户名已存在')
    const updated: AdminUser = { ...user, username: name, role: patch.role ?? user.role, passwordHash: passwordHash ?? user.passwordHash }
    const users = this.users.map((candidate, candidateIndex) => candidateIndex === index ? updated : candidate)
    // Revoke sessions durably before changing credentials, so a failed user-file
    // write cannot leave old sessions valid after a successful password change.
    if (name !== username || passwordHash !== undefined)
      this.revokeUserSessions(username)
    this.persistUsers(users)
    this.users = users
    return { username: name, role: updated.role }
  }

  deleteUser(username: string): void {
    const user = this.users.find(candidate => candidate.username === username)
    if (!user)
      throw new UserManagementError(404, '用户不存在')
    this.revokeUserSessions(username)
    const users = this.users.filter(candidate => candidate !== user)
    this.persistUsers(users)
    this.users = users
  }

  private findAccount(username: string): AdminUser | undefined {
    return this.systemUsers.find(user => user.username === username) ?? this.users.find(user => user.username === username)
  }

  private revokeUserSessions(username: string): void {
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

  private persistUsers(users: AdminUser[]): void {
    mkdirSync(dirname(this.usersFile), { recursive: true })
    const temporaryFile = `${this.usersFile}.${randomBytes(6).toString('hex')}.tmp`
    try {
      writeFileSync(temporaryFile, `${JSON.stringify({ users }, undefined, 2)}\n`, { mode: 0o600 })
      renameSync(temporaryFile, this.usersFile)
    }
    catch (error) {
      rmSync(temporaryFile, { force: true })
      throw error
    }
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

function validateUsername(username: string): string {
  const name = username.trim()
  if (!name || name.length > 18)
    throw new UserManagementError(400, '用户名长度应为 1–18 个字符')
  return name
}

async function createPasswordHash(password: string): Promise<string> {
  if (!password || password.length > 32)
    throw new UserManagementError(400, '密码长度应为 1–32 个字符')
  const salt = randomBytes(16)
  const derived = await derivePassword(password, salt, 32)
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`
}

function parseUsers(text: string, system: boolean): AdminUser[] {
  const filename = system ? 'admin.json' : 'users.json'
  const parsed = JSON.parse(text) as unknown
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { users?: unknown }).users))
    throw new Error(`${filename} must contain a users array`)
  const users = (parsed as { users: unknown[] }).users.map((value): AdminUser => {
    if (typeof value !== 'object' || value === null)
      throw new Error(`${filename} contains an invalid user`)
    const { passwordHash, role, username } = value as Record<string, unknown>
    if (typeof username !== 'string' || username.length === 0 || typeof passwordHash !== 'string')
      throw new Error(`${filename} user requires username and passwordHash`)
    return { passwordHash, role: system ? 'admin' : role === 'admin' || role === 'editor' ? role : 'viewer', username }
  })
  if (system && users.length === 0)
    throw new Error('admin.json must contain at least one user')
  if (new Set(users.map(user => user.username)).size !== users.length)
    throw new Error('Usernames must be unique')
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

async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [kind, saltText, expectedText] = encoded.split('$')
  if (kind !== 'scrypt' || !saltText || !expectedText)
    return false
  try {
    const expected = Buffer.from(expectedText, 'base64')
    const actual = await derivePassword(password, Buffer.from(saltText, 'base64'), expected.length)
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  }
  catch {
    return false
  }
}

function derivePassword(password: string, salt: Buffer, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, length, (error, derivedKey) => {
      if (error)
        reject(error)
      else
        resolve(derivedKey)
    })
  })
}
