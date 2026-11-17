import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { SPEAKER_MODEL_NAME, SPEAKER_MODEL_SHA256, SPEAKER_MODEL_URL } from '../apps/backend/src/ai/speaker-model.mjs'

const target = fileURLToPath(new URL(`../config/models/${SPEAKER_MODEL_NAME}`, import.meta.url))
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const existing = await readFile(target).catch(error => error.code === 'ENOENT' ? undefined : Promise.reject(error))
if (existing && sha256(existing) === SPEAKER_MODEL_SHA256) {
  console.log(`Speaker model verified: ${target}`)
}
else {
  const response = await fetch(SPEAKER_MODEL_URL, { signal: AbortSignal.timeout(180_000) })
  if (!response.ok)
    throw new Error(`Speaker model download failed: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (sha256(bytes) !== SPEAKER_MODEL_SHA256)
    throw new Error('Downloaded speaker model SHA-256 mismatch')
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.tmp`
  try {
    await writeFile(temporary, bytes, { flag: 'wx' })
    await rename(temporary, target)
  }
  finally {
    await rm(temporary, { force: true })
  }
  console.log(`Speaker model downloaded and verified: ${target}`)
}
