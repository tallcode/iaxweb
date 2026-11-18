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
      { callsign: 'BG5NUL', referenceSimilarity: null, referenceRecordCount: 0, trimmedReferenceSimilarity: null, trimmedReferenceRecordCount: 0, referenceGroups: [] },
      { callsign: 'BG5BAD', referenceSimilarity: null, referenceRecordCount: 0, trimmedReferenceSimilarity: null, trimmedReferenceRecordCount: 0, referenceGroups: [] },
    ])
    assert.deepEqual(query, vector(1))
    assert.deepEqual(positive, vector(0.8, 0.6))
    const again = await extractor.scoreReferences(query, [{ callsign: 'BG5ABC', embeddings: [vector(0, 1)] }])
    assert.ok(Math.abs(again[0]!.referenceSimilarity!) < 1e-6)
    assert.equal(again[0]?.referenceRecordCount, 1)
  }
  finally { extractor.stop() }
})

test('reference groups start at five and discard groups at or below twenty percent', async () => {
  const extractor = new SpeakerExtractor('/missing/model.onnx')
  try {
    const layouts = [[4], [3, 2], [5, 3, 2], [8, 4, 3], [7, 4, 3, 2], [1, 1, 1, 1, 1]]
    const groups = layouts.map((sizes, index) => ({
      callsign: `BG5X${String.fromCharCode(65 + index)}`,
      embeddings: sizes.flatMap((size, axis) => {
        const embedding = new Float32Array(SPEAKER_DIMENSIONS)
        embedding[axis] = 1
        return Array.from<Float32Array>({ length: size }).fill(embedding)
      }),
    }))
    const scores = await extractor.scoreReferences(vector(1), groups)
    assert.deepEqual(scores.map(score => score.referenceRecordCount), [4, 5, 10, 15, 16, 5])
    assert.deepEqual(scores.map(score => score.trimmedReferenceRecordCount), [4, 4, 8, 12, 13, 4])
    assert.equal(scores[0]?.trimmedReferenceSimilarity, scores[0]?.referenceSimilarity)
    assert.deepEqual(scores.map(score => score.referenceGroups.map(group => group.recordCount)), [[], [3, 2], [5, 3], [8, 4], [7, 4], []])
    assert.ok(scores[4]!.referenceGroups[0]!.similarity > 0.999999)
    assert.ok(Math.abs(scores[4]!.referenceGroups[1]!.similarity) < 1e-6)
  }
  finally { extractor.stop() }
})

test('trimmed synthesis discards outliers by reference agreement even when they match the query', async () => {
  const extractor = new SpeakerExtractor('/missing/model.onnx')
  try {
    const typical = vector(1)
    const query = vector(0, 1)
    const embeddings = [...Array.from<Float32Array>({ length: 3 }).fill(query), ...Array.from<Float32Array>({ length: 13 }).fill(typical)]
    const [score] = await extractor.scoreReferences(query, [{ callsign: 'BG5ABC', embeddings }])
    assert.ok(score!.referenceSimilarity! > 0.2)
    assert.equal(score!.trimmedReferenceRecordCount, 13)
    assert.ok(Math.abs(score!.trimmedReferenceSimilarity!) < 1e-6)
    assert.deepEqual(score!.referenceGroups.map(group => group.recordCount), [13])
  }
  finally { extractor.stop() }
})

test('complete linkage keeps a bridging reference from chaining two dissimilar sets together', async () => {
  const extractor = new SpeakerExtractor('/missing/model.onnx')
  try {
    const a = vector(1)
    const b = vector(0.8, 0.6)
    const c = vector(0.28, 0.96)
    const scores = await extractor.scoreReferences(a, [{ callsign: 'BG5ABC', embeddings: [a, a, b, b, c, c] }])
    assert.deepEqual(scores[0]?.referenceGroups.map(group => group.recordCount), [4, 2])
  }
  finally { extractor.stop() }
})
