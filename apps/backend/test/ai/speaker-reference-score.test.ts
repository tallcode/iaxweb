import assert from 'node:assert/strict'
import test from 'node:test'
import { SPEAKER_DIMENSIONS } from '../../src/ai/speaker-model.mjs'
import { SpeakerExtractor } from '../../src/ai/speaker.js'

function vector(first: number, second: number = 0): Float32Array {
  const result = new Float32Array(SPEAKER_DIMENSIONS)
  result[0] = first
  result[1] = second
  return result
}

test('addMulti scores its native centroid independently from model loading', async () => {
  const extractor = new SpeakerExtractor('/missing/model.onnx')
  try {
    const query = vector(1)
    const positive = vector(0.8, 0.6)
    const negative = vector(0.8, -0.6)
    const scores = await extractor.scoreReferences(query, [
      { callsign: 'BG5ABC', embeddings: [positive, negative] },
      { callsign: 'BG5XYZ', embeddings: [vector(0, 1)] },
      { callsign: 'BG5LOW', embeddings: [vector(-1)] },
      { callsign: 'BG5NUL', embeddings: [] },
      { callsign: 'BG5BAD', embeddings: [query, vector(-1)] },
    ])
    assert.ok(Math.abs(scores[0]!.referenceSimilarity! - 1) < 1e-6)
    assert.equal(scores[0]?.referenceRecordCount, 2)
    assert.ok(Math.abs(scores[1]!.referenceSimilarity!) < 1e-6)
    assert.ok(Math.abs(scores[2]!.referenceSimilarity! + 1) < 1e-6)
    assert.deepEqual(scores.slice(3), [
      { callsign: 'BG5NUL', referenceSimilarity: null, referenceRecordCount: 0, trimmedReferenceSimilarity: null, trimmedReferenceRecordCount: 0 },
      { callsign: 'BG5BAD', referenceSimilarity: null, referenceRecordCount: 0, trimmedReferenceSimilarity: null, trimmedReferenceRecordCount: 0 },
    ])
    assert.deepEqual(query, vector(1))
    assert.deepEqual(positive, vector(0.8, 0.6))
    const again = await extractor.scoreReferences(query, [{ callsign: 'BG5ABC', embeddings: [vector(0, 1)] }])
    assert.ok(Math.abs(again[0]!.referenceSimilarity!) < 1e-6)
    assert.equal(again[0]?.referenceRecordCount, 1)
  }
  finally { extractor.stop() }
})

test('trims the least consistent references independently of the query', async () => {
  const extractor = new SpeakerExtractor('/missing/model.onnx')
  try {
    const majority = vector(1)
    const outlier = vector(0, 1)
    const groups = [4, 5, 9, 10].map((count, index) => ({
      callsign: `BG5X${index}`,
      embeddings: Array.from({ length: count }, (_, i) => i < Math.max(1, Math.floor(count / 5)) ? outlier : majority),
    }))
    const scores = await extractor.scoreReferences(majority, groups)
    assert.deepEqual(scores.map(score => score.referenceRecordCount), [4, 5, 9, 10])
    assert.deepEqual(scores.map(score => score.trimmedReferenceRecordCount), [4, 4, 8, 8])
    assert.equal(scores[0]?.trimmedReferenceSimilarity, scores[0]?.referenceSimilarity)
    for (const score of scores.slice(1)) {
      assert.ok(score.referenceSimilarity! < 0.999)
      assert.ok(score.trimmedReferenceSimilarity! > 0.999999)
    }
    const outlierScores = await extractor.scoreReferences(outlier, groups)
    for (const score of outlierScores.slice(1)) {
      assert.ok(score.referenceSimilarity! > 0.1)
      assert.ok(Math.abs(score.trimmedReferenceSimilarity!) < 1e-6)
    }
  }
  finally { extractor.stop() }
})
