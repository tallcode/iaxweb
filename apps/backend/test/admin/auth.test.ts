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

test('uses system administrators from admin.json and defaults legacy managed users to viewer', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'iaxweb-admin-roles-'))
  t.after(() => rmSync(directory, { force: true, recursive: true }))
  const file = join(directory, 'admin.json')
  const passwordHash = hashPassword('secret')
  writeFileSync(file, JSON.stringify({ users: [{ username: 'root', passwordHash, role: 'viewer' }] }))
  writeFileSync(join(directory, 'users.json'), JSON.stringify({ users: [
    { username: 'admin', passwordHash },
    { username: 'null-role', passwordHash, role: null },
    { username: 'empty-role', passwordHash, role: '' },
    { username: 'unknown-role', passwordHash, role: 'superuser' },
    { username: 'administrator', passwordHash, role: 'admin' },
    { username: 'editor', passwordHash, role: 'editor' },
  ] }))
  const auth = new AdminAuth(file, join(directory, 'sessions.json'))
  for (const [username, role] of [['admin', 'viewer'], ['null-role', 'viewer'], ['empty-role', 'viewer'], ['unknown-role', 'viewer'], ['administrator', 'admin'], ['editor', 'editor']]) {
    const token = await auth.login(username!, 'secret')
    assert.ok(token)
    assert.deepEqual(auth.getUser(token), { username, role })
  }
  const systemToken = await auth.login('root', 'secret')
  assert.deepEqual(auth.getUser(systemToken), { username: 'root', role: 'admin', system: true })
  assert.equal(auth.findUser('root'), undefined)
  assert.equal(auth.listUsers().some(user => user.username === 'root'), false)
  assert.equal(auth.getUser(undefined), undefined)
  assert.equal(auth.getUser('invalid'), undefined)
})

test('uses the current user role when restoring a persisted session', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'iaxweb-admin-role-session-'))
  t.after(() => rmSync(directory, { force: true, recursive: true }))
  const file = join(directory, 'admin.json')
  const sessionsFile = join(directory, 'sessions.json')
  const user = { username: 'managed', passwordHash: hashPassword('secret') }
  writeFileSync(file, JSON.stringify({ users: [{ username: 'root', passwordHash: user.passwordHash }] }))
  const managedFile = join(directory, 'users.json')
  writeFileSync(managedFile, JSON.stringify({ users: [{ ...user, role: 'admin' }] }))
  const token = await new AdminAuth(file, sessionsFile).login('managed', 'secret')
  assert.ok(token)
  writeFileSync(managedFile, JSON.stringify({ users: [user] }))
  const auth = new AdminAuth(file, sessionsFile)
  assert.deepEqual(auth.getUser(token), { username: 'managed', role: 'viewer' })
})

test('persists managed users separately and protects hidden system accounts', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'iaxweb-managed-users-'))
  t.after(() => rmSync(directory, { force: true, recursive: true }))
  const file = join(directory, 'admin.json')
  const sessions = join(directory, 'sessions.json')
  const system = JSON.stringify({ users: [{ username: 'root', passwordHash: hashPassword('secret') }] })
  writeFileSync(file, system)
  const auth = new AdminAuth(file, sessions)
  assert.deepEqual(auth.listUsers(), [])
  await auth.createUser('operator', 'first-password', 'editor')
  const token = await auth.login('operator', 'first-password')
  assert.ok(token)
  assert.deepEqual(auth.getUser(token), { username: 'operator', role: 'editor' })
  await auth.updateUser('operator', { role: 'admin' })
  assert.equal(auth.getUser(token)?.role, 'admin')
  await auth.updateUser('operator', { password: 'new-password' })
  assert.equal(auth.isAuthenticated(token), false)
  assert.equal(new AdminAuth(file, sessions).isAuthenticated(token), false)
  assert.equal(await auth.login('operator', 'first-password'), undefined)
  const replacement = await auth.login('operator', 'new-password')
  assert.ok(replacement)
  await auth.updateUser('operator', { username: 'renamed' })
  assert.equal(auth.isAuthenticated(replacement), false)
  assert.equal(auth.findUser('operator'), undefined)
  const renamed = await auth.login('renamed', 'new-password')
  assert.ok(renamed)
  auth.deleteUser('renamed')
  assert.equal(auth.isAuthenticated(renamed), false)
  assert.deepEqual(new AdminAuth(file, sessions).listUsers(), [])
  assert.equal(readFileSync(file, 'utf8'), system)
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'users.json'), 'utf8')), { users: [] })
  await assert.rejects(auth.createUser('root', 'password', 'viewer'), { statusCode: 409 })
  await assert.rejects(auth.updateUser('root', { role: 'viewer' }), { statusCode: 404 })
  assert.throws(() => auth.deleteUser('root'), { statusCode: 404 })
  assert.equal(readFileSync(file, 'utf8'), system)
})

test('does not allow concurrent creations to duplicate a username', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'iaxweb-user-conflict-'))
  t.after(() => rmSync(directory, { force: true, recursive: true }))
  const file = join(directory, 'admin.json')
  writeFileSync(file, JSON.stringify({ users: [{ username: 'admin', passwordHash: hashPassword('secret') }] }))
  const auth = new AdminAuth(file, join(directory, 'sessions.json'))
  const results = await Promise.allSettled([
    auth.createUser('same-name', 'password', 'editor'),
    auth.createUser('same-name', 'password', 'viewer'),
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(auth.listUsers().length, 1)
})
