import { Buffer } from 'node:buffer'
import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto'
import { UserManagementError } from './user-errors.js'

export function hashPassword(password: string, salt: Buffer = randomBytes(16)): string {
  if (password.length === 0)
    throw new Error('Password cannot be empty')
  const derived = scryptSync(password, salt, 32)
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`
}

export async function createPasswordHash(password: string): Promise<string> {
  if (!password || password.length > 32)
    throw new UserManagementError(400, '密码长度应为 1–32 个字符')
  const salt = randomBytes(16)
  const derived = await derivePassword(password, salt, 32)
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
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
