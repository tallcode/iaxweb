import process from 'node:process'
import { hashPassword } from '../src/admin/auth.js'

const password = process.argv[2]
if (!password)
  throw new Error('Usage: npm run hash-admin-password -- <password>')
console.log(hashPassword(password))
