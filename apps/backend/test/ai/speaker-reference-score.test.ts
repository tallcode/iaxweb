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
      { callsign: 'BG5NUL', referenceSimilarity: null, referenceRecordCount: 0 },
      { callsign: 'BG5BAD', referenceSimilarity: null, referenceRecordCount: 0 },
    ])
    assert.deepEqual(query, vector(1))
    assert.deepEqual(positive, vector(0.8, 0.6))
    const again = await extractor.scoreReferences(query, [{ callsign: 'BG5ABC', embeddings: [vector(0, 1)] }])
    assert.ok(Math.abs(again[0]!.referenceSimilarity!) < 1e-6)
    assert.equal(again[0]?.referenceRecordCount, 1)
  }
  finally { extractor.stop() }
})
