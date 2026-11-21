import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { RecordRepository } from '../../src/records/record-repository.js'

test('legacy history upgrades with an independent signaling column and preserves manual/AI values', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'iaxweb-signaling-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = join(directory, 'history.sqlite')
  const record = { id: 'segment-1', timestamp: '2026-11-21T12:00:00.000Z', durationMs: 1000, voicedMs: 500, recognition: 'existing transcript', callsign: 'BG5ABC', callsignAlgorithm: 'stage1_text' }
  const before = new RecordRepository(file)
  before.insert('1900', record)
  before.updateAnalysis(record)
  before.updateManualReview(record.id, { callsign: 'BG5XYZ', recognition: 'manual transcript' })
  before.close()
  const legacy = new DatabaseSync(file)
  legacy.exec('ALTER TABLE ai_segments DROP COLUMN signaling')
  legacy.close()
  const repository = new RecordRepository(file)
  try {
    assert.equal(repository.find(record.id)?.signaling, null)
    assert.equal(repository.updateSignaling(record.id, [{ type: 'BSS', content: 'N0CALL' }]), true)
    const result = repository.find(record.id)!
    assert.deepEqual(result.signaling, [{ type: 'BSS', content: 'N0CALL' }])
    assert.equal(result.callsign, 'BG5ABC')
    assert.equal(result.callsignAlgorithm, 'stage1_text')
    assert.equal(result.manualCallsign, 'BG5XYZ')
    assert.equal(result.manualRecognition, 'manual transcript')
    assert.deepEqual(repository.list(1, 10).items[0]?.signaling, result.signaling)
    repository.updateAnalysis(record)
    assert.deepEqual(repository.find(record.id)?.signaling, result.signaling)
    repository.delete(record.id, () => {})
    assert.equal(repository.updateSignaling(record.id, []), false)
    assert.equal(repository.find(record.id), undefined)
  }
  finally { repository.close() }
})
