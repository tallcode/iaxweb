import type { AdminRole, AdminSession } from '@iaxweb/contracts'
import type { UserUpdate } from './user-store.js'
import { hashPassword, verifyPassword } from './password-hasher.js'
import { SESSION_MAX_AGE_MS, SessionStore } from './session-store.js'
import { UserStore } from './user-store.js'

export { hashPassword } from './password-hasher.js'
export { UserManagementError } from './user-errors.js'
export type { UserUpdate } from './user-store.js'

const DUMMY_PASSWORD_HASH = hashPassword('invalid-admin-password')

export class AdminAuth {
  static readonly sessionMaxAgeSeconds = SESSION_MAX_AGE_MS / 1_000
  private readonly sessions: SessionStore
  private readonly users: UserStore

  constructor(usersFile: string, sessionsFile: string, now: () => Date = () => new Date()) {
    // Load accounts first; no session is created until account configuration is valid.
    this.users = new UserStore(usersFile, sessionsFile, username => this.sessions.revokeUserSessions(username))
    this.sessions = new SessionStore(sessionsFile, now)
  }

  async login(username: string, password: string): Promise<string | undefined> {
    this.sessions.removeExpiredSessions()
    const user = this.users.findAccount(username)
    const verified = await verifyPassword(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH)
    if (!user || !verified || this.users.findAccount(username)?.passwordHash !== user.passwordHash)
      return undefined
    return this.sessions.create(username)
  }

  logout(token: string | undefined): void { this.sessions.logout(token) }
  isAuthenticated(token: string | undefined): boolean { return this.getUser(token) !== undefined }
  getUser(token: string | undefined): AdminSession | undefined {
    const username = this.sessions.getUsername(token)
    return username === undefined ? undefined : this.users.getSessionUser(username)
  }

  listUsers(): AdminSession[] { return this.users.listUsers() }
  findUser(username: string): AdminSession | undefined { return this.users.findUser(username) }
  createUser(username: string, password: string, role: AdminRole): Promise<AdminSession> { return this.users.createUser(username, password, role) }
  updateUser(username: string, patch: UserUpdate): Promise<AdminSession> { return this.users.updateUser(username, patch) }
  deleteUser(username: string): void { this.users.deleteUser(username) }
}
