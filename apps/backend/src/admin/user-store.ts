import type { AdminRole, AdminSession, UpdateUserInput } from '@iaxweb/contracts'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createPasswordHash } from './password-hasher.js'
import { UserManagementError } from './user-errors.js'

interface AdminUser extends AdminSession { passwordHash: string }
export type UserUpdate = UpdateUserInput

export class UserStore {
  private readonly systemUsers: AdminUser[]
  private users: AdminUser[]
  private readonly usersFile: string

  constructor(usersFile: string, sessionsFile: string, private readonly onCredentialChange: (username: string) => void) {
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
  }

  getSessionUser(username: string): AdminSession | undefined {
    const system = this.systemUsers.find(user => user.username === username)
    return system ? { username, role: 'admin', system: true } : this.findUser(username)
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
      this.onCredentialChange(username)
    this.persistUsers(users)
    this.users = users
    return { username: name, role: updated.role }
  }

  deleteUser(username: string): void {
    const user = this.users.find(candidate => candidate.username === username)
    if (!user)
      throw new UserManagementError(404, '用户不存在')
    this.onCredentialChange(username)
    const users = this.users.filter(candidate => candidate !== user)
    this.persistUsers(users)
    this.users = users
  }

  findAccount(username: string): AdminUser | undefined {
    return this.systemUsers.find(user => user.username === username) ?? this.users.find(user => user.username === username)
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
}

function validateUsername(username: string): string {
  const name = username.trim()
  if (!name || name.length > 18)
    throw new UserManagementError(400, '用户名长度应为 1–18 个字符')
  return name
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

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
