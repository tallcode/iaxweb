import type { BackfillMode, BackfillResult, EmbeddingBackfillStore } from '../../records/embedding-backfill-store.js'
import { rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'

export async function createBackfillBackup(store: EmbeddingBackfillStore, directory: string, signal?: AbortSignal): Promise<string> {
  const target = join(directory, 'backup.sqlite')
  const temporary = join(directory, 'backup.tmp.sqlite')
  try {
    await backup(store.database, temporary, { rate: 100 })
    signal?.throwIfAborted()
    const inspect = new DatabaseSync(temporary, { readOnly: true })
    try {
      if (inspect.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok')
        throw new Error('Backfill backup integrity check failed')
    }
    finally { inspect.close() }
    await rename(temporary, target)
    return target
  }
  finally { await rm(temporary, { force: true }) }
}

function sqliteBusy(error: unknown): boolean {
  return error instanceof Error && (
    ('errcode' in error && [5, 6].includes(Number(error.errcode) & 0xFF))
    || /SQLITE_BUSY|SQLITE_LOCKED|database (?:table )?is locked/.test(error.message)
  )
}

export async function commitBackfillBatch(store: EmbeddingBackfillStore, batch: BackfillResult[], mode: BackfillMode, signal?: AbortSignal): Promise<BackfillResult[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      return store.commit(batch, mode)
    }
    catch (error) {
      if (!sqliteBusy(error) || attempt >= 4)
        throw error
      await sleep(100 * 2 ** attempt, undefined, signal ? { signal } : {})
    }
  }
}
