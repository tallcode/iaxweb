import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AdminAuth, hashPassword } from '../../src/admin/auth.js'

test('authenticates an admin user with a scrypt hash', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'iaxweb-admin-'))
  t.after(() => rmSync(directory, { force: true, recursive: true }))
  const file = join(directory, 'admin.json')
  const sessionsFile = join(directory, 'sessions.json')
  writeFileSync(file, JSON.stringify({ users: [{ passwordHash: hashPassword('secret'), username: 'admin' }] }))
  const auth = new AdminAuth(file, sessionsFile)

  assert.deepEqual(JSON.parse(readFileSync(sessionsFile, 'utf8')), { sessions: [] })
  assert.equal(await auth.login('admin', 'bad'), undefined)
  assert.equal(await auth.login('missing', 'secret'), undefined)
  const token = await auth.login('admin', 'secret')
  assert.ok(token)
  assert.equal(auth.isAuthenticated(token), true)
  assert.equal(new AdminAuth(file, sessionsFile).isAuthenticated(token), true)
  auth.logout(token)
  assert.equal(auth.isAuthenticated(token), false)
})

test('removes expired sessions when loading the session file', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'iaxweb-admin-'))
  t.after(() => rmSync(directory, { force: true, recursive: true }))
  const usersFile = join(directory, 'admin.json')
  const sessionsFile = join(directory, 'sessions.json')
  writeFileSync(usersFile, JSON.stringify({ users: [{ passwordHash: hashPassword('secret'), username: 'admin' }] }))
  writeFileSync(sessionsFile, JSON.stringify({
    sessions: [{
      expiresAt: '2026-08-01T00:00:00.000Z',
      tokenHash: 'a'.repeat(64),
      username: 'admin',
    }],
  }))

  const auth = new AdminAuth(usersFile, sessionsFile, () => new Date('2026-08-13T00:00:00.000Z'))

  assert.equal(auth.isAuthenticated('anything'), false)
  assert.deepEqual(JSON.parse(readFileSync(sessionsFile, 'utf8')), { sessions: [] })
})
