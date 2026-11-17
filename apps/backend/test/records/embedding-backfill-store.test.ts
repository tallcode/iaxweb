import type { BackfillResult } from '../../src/records/embedding-backfill-store.js'
import type { Voiceprint } from '../../src/records/types.js'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { SPEAKER_DIMENSIONS } from '../../src/ai/speaker-model.mjs'
import { eligibleForBackfill, EmbeddingBackfillStore } from '../../src/records/embedding-backfill-store.js'
import { RecordRepository } from '../../src/records/record-repository.js'
import { encodeVoiceprint } from '../../src/records/voiceprint.js'

function setup(t: { after: (callback: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'iaxweb-backfill-store-'))
  t.after(() => rmSync(directory, { force: true, recursive: true }))
  const filename = join(directory, 'ai.sqlite')
  const repository = new RecordRepository(filename)
  const insert = (id: string) => {
    repository.insert('1900', { id, recognition: '原文', timestamp: '2026-11-17T03:00:00Z', durationMs: 2000, voicedMs: 1500 })
    const database = new DatabaseSync(filename)
    database.prepare('UPDATE ai_segments SET reviewed = 1 WHERE id = ?').run(id)
    database.close()
  }
  const put = (id: string, voiceprint: Voiceprint) => {
    const database = new DatabaseSync(filename)
    database.prepare('INSERT INTO ai_segment_embeddings(record_id, version, status, embedding) VALUES (?, ?, ?, ?)').run(id, voiceprint.version, voiceprint.status, encodeVoiceprint(voiceprint))
    database.close()
  }
  const embedding = new Float32Array(SPEAKER_DIMENSIONS)
  embedding[0] = 1
  return { filename, repository, insert, embedding, put }
}

test('the backfill connection never resets live pending embeddings', (t) => {
  const { filename, repository, insert, put } = setup(t)
  insert('live')
  put('live', { status: 'pending', version: 'v1' })
  const store = new EmbeddingBackfillStore(filename, false)
  assert.deepEqual(store.current('live'), { status: 'pending', version: 'v1', reviewed: true })
  store.close()
  repository.close()
})

test('guarded commits preserve concurrent completion and deletion', (t) => {
  const { filename, repository, insert, embedding, put } = setup(t)
  insert('completed')
  insert('deleted')
  insert('missing')
  const store = new EmbeddingBackfillStore(filename, false)
  put('completed', { status: 'ready', version: 'online', embedding })
  repository.delete('deleted', () => {})
  const batch: BackfillResult[] = ['completed', 'deleted', 'missing'].map((id, index) => ({
    index,
    id,
    outcome: 'ready',
    reason: 'extracted',
    voiceprint: { status: 'ready', version: 'v1', embedding },
  }))
  assert.deepEqual(store.commit(batch, 'missing').map(result => result.outcome), ['skipped', 'skipped', 'ready'])
  assert.deepEqual(store.current('completed'), { status: 'ready', version: 'online', reviewed: true })
  assert.deepEqual(store.coverage(['completed', 'deleted', 'missing'], 'v1'), {
    ready: 1,
    failed: 0,
    unavailable: 0,
    pending: 0,
    missingEmbedding: 0,
    deleted: 1,
    otherVersion: 1,
  })
  store.close()
  repository.close()
})

test('retry only overwrites the selected terminal state and exact version', (t) => {
  const { filename, repository, insert, embedding, put } = setup(t)
  for (const id of ['failed', 'pending', 'other', 'unavailable'])
    insert(id)
  put('failed', { status: 'failed', version: 'v1' })
  put('pending', { status: 'pending', version: 'v1' })
  put('other', { status: 'failed', version: 'v2' })
  put('unavailable', { status: 'unavailable', version: 'v1' })
  const store = new EmbeddingBackfillStore(filename, false)
  const results: BackfillResult[] = ['failed', 'pending', 'other', 'unavailable'].map((id, index) => ({
    index,
    id,
    outcome: 'ready',
    reason: 'retry',
    voiceprint: { status: 'ready', version: 'v1', embedding },
  }))
  assert.deepEqual(store.commit(results, 'failed').map(result => result.outcome), ['ready', 'skipped', 'skipped', 'skipped'])
  assert.equal(eligibleForBackfill({ status: 'failed', version: 'v1', reviewed: true }, 'failed', 'v1'), true)
  assert.equal(eligibleForBackfill({ status: 'failed', version: 'v2', reviewed: true }, 'failed', 'v1'), false)
  store.close()
  repository.close()
})

test('backfill persists interference rejection reason without a vector', (t) => {
  const { filename, repository, insert } = setup(t)
  insert('interference')
  const store = new EmbeddingBackfillStore(filename, false)
  const voiceprint = { status: 'unavailable', version: 'quality-v1', reason: 'interference_high_band' } as const
  const result = store.commit([{ id: 'interference', index: 0, outcome: 'unavailable', reason: voiceprint.reason, voiceprint }], 'missing')
  assert.equal(result[0]?.outcome, 'unavailable')
  assert.equal(store.database.prepare('SELECT reason FROM ai_segment_embeddings').get()?.reason, voiceprint.reason)
  assert.equal(store.database.prepare('SELECT embedding FROM ai_segment_embeddings').get()?.embedding, null)
  store.close()
  repository.close()
})

test('default backfill replaces only the selected old version and preserves concurrent completion', (t) => {
  const { filename, repository, insert, embedding, put } = setup(t)
  for (const id of ['legacy', 'concurrent', 'cancelled']) {
    insert(id)
    put(id, { status: 'ready', version: 'old-model', embedding })
  }
  const store = new EmbeddingBackfillStore(filename, false)
  assert.equal(eligibleForBackfill(store.current('legacy')!, 'missing', 'new-model'), true)
  store.database.prepare('UPDATE ai_segment_embeddings SET version = ? WHERE record_id = ?').run('new-model', 'concurrent')
  repository.updateManualReview('cancelled', { reviewed: false })
  const results: BackfillResult[] = ['legacy', 'concurrent', 'cancelled'].map((id, index) => ({
    id,
    index,
    outcome: 'ready',
    reason: 'upgraded',
    previousVersion: 'old-model',
    voiceprint: { status: 'ready', version: 'new-model', embedding },
  }))
  assert.deepEqual(store.commit(results, 'missing').map(row => row.outcome), ['ready', 'skipped', 'skipped'])
  assert.equal(store.current('legacy')?.version, 'new-model')
  assert.equal(store.current('cancelled')?.version, 'old-model')
  assert.equal(eligibleForBackfill(store.current('concurrent')!, 'missing', 'new-model'), false)
  store.close()
  repository.close()
})

test('unreviewed records cannot enter inventory or receive an in-flight backfill write', (t) => {
  const { filename, repository, insert, embedding } = setup(t)
  insert('cancelled')
  const store = new EmbeddingBackfillStore(filename, false)
  const current = store.current('cancelled')!
  assert.equal(eligibleForBackfill(current, 'missing', 'v1'), true)
  repository.updateManualReview('cancelled', { reviewed: false })
  assert.deepEqual(store.page('9999-01-01'), [])
  assert.equal(eligibleForBackfill(store.current('cancelled')!, 'missing', 'v1'), false)
  const result = store.commit([{ id: 'cancelled', index: 0, outcome: 'ready', reason: 'extracted', voiceprint: { status: 'ready', version: 'v1', embedding } }], 'missing')
  assert.equal(result[0]?.outcome, 'skipped')
  assert.equal(store.database.prepare('SELECT COUNT(*) AS n FROM ai_segment_embeddings').get()?.n, 0)
  store.close()
  repository.close()
})
