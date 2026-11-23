import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import process from 'node:process'
import { z } from 'zod'

export async function writeBackfillJson(filename: string, value: unknown): Promise<void> {
  const temporary = `${filename}.${process.pid}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, filename)
  }
  finally {
    await rm(temporary, { force: true })
  }
}

export function fileErrorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined
}

export function isPermissionError(error: unknown): boolean {
  return ['EACCES', 'EPERM', 'EIO', 'EMFILE', 'ENFILE', 'ENOSPC', 'EROFS'].includes(fileErrorCode(error) ?? '')
}

// Exclusive per-database backfill process. Online recording is never locked by
// this file. A stale lock can be reclaimed on the same host after a hard exit.
export async function acquireBackfillLock(filename: string): Promise<() => Promise<void>> {
  const contents = JSON.stringify({ pid: process.pid, host: hostname(), token: randomUUID() })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(filename, contents, { flag: 'wx', mode: 0o600 })
      return async () => {
        if (await readFile(filename, 'utf8').catch(() => '') === contents)
          await rm(filename, { force: true })
      }
    }
    catch (error) {
      if (fileErrorCode(error) !== 'EEXIST')
        throw error
      const previous = await readFile(filename, 'utf8')
      const owner = z.object({ pid: z.number().int().positive(), host: z.string() }).parse(JSON.parse(previous))
      let alive = true
      if (owner.host === hostname()) {
        try {
          process.kill(owner.pid, 0)
        }
        catch (checkError) { alive = fileErrorCode(checkError) !== 'ESRCH' }
      }
      if (alive || attempt !== 0)
        throw new Error(`Another backfill owns ${filename}; for a stale lock on another host/container, verify its process has stopped before removing it`)
      if (await readFile(filename, 'utf8') === previous)
        await rm(filename)
    }
  }
  throw new Error('Could not acquire backfill lock')
}
