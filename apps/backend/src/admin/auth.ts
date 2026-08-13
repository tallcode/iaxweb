import { Buffer } from 'node:buffer'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'

interface AdminUser {
  passwordHash: string
  username: string
}

// In-memory sessions deliberately disappear on restart. Password hashes use
// scrypt$<base64 salt>$<base64 derived key> and never store cleartext values.
export class AdminAuth {
  private readonly sessions = new Set<string>()
  private readonly users: AdminUser[]

  constructor(file: string) {
    this.users = parseUsers(readFileSync(file, 'utf8'))
  }

  login(username: string, password: string): string | undefined {
    const user = this.users.find(candidate => candidate.username === username)
    if (!user || !verifyPassword(password, user.passwordHash))
      return undefined
    const token = randomBytes(32).toString('base64url')
    this.sessions.add(token)
    return token
  }

  logout(token: string | undefined): void {
    if (token)
      this.sessions.delete(token)
  }

  isAuthenticated(token: string | undefined): boolean {
    return token !== undefined && this.sessions.has(token)
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
