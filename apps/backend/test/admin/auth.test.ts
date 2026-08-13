import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AdminAuth, hashPassword } from '../../src/admin/auth.js'

test('authenticates an admin user with a scrypt hash', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'iaxweb-admin-'))
  t.after(() => rmSync(directory, { force: true, recursive: true }))
  const file = join(directory, 'admin.json')
  writeFileSync(file, JSON.stringify({ users: [{ passwordHash: hashPassword('secret'), username: 'admin' }] }))
  const auth = new AdminAuth(file)

  assert.equal(auth.login('admin', 'bad'), undefined)
  const token = auth.login('admin', 'secret')
  assert.ok(token)
  assert.equal(auth.isAuthenticated(token), true)
  auth.logout(token)
  assert.equal(auth.isAuthenticated(token), false)
})
