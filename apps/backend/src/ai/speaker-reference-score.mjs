import { SPEAKER_DIMENSIONS } from './speaker-model.mjs'

function validVector(vector) {
  if (!(vector instanceof Float32Array) || vector.length !== SPEAKER_DIMENSIONS)
    return false
  let squared = 0
  for (const value of vector) {
    if (!Number.isFinite(value))
      return false
    squared += value * value
  }
  return squared > 0
}

// sherpa-onnx-node 2.0.1 exposes addMulti/verify, but no numeric score or
// centroid getter. Threshold bisection queries the actual native centroid;
// 25 iterations bound the score error to about 1e-7, well below UI precision.
export function scoreSpeakerReferences(sherpa, query, groups) {
  if (!validVector(query))
    throw new Error('Invalid reference query vector')
  const manager = new sherpa.SpeakerEmbeddingManager(SPEAKER_DIMENSIONS)
  return groups.map(({ callsign, embeddings }) => {
    const unavailable = { callsign, referenceSimilarity: null, referenceRecordCount: 0 }
    if (embeddings.length === 0 || embeddings.length > 10 || !embeddings.every(validVector))
      return unavailable
    const sum = new Float64Array(SPEAKER_DIMENSIONS)
    for (const embedding of embeddings) {
      for (let i = 0; i < SPEAKER_DIMENSIONS; i++)
        sum[i] += embedding[i]
    }
    // Opposing/degenerate references have no meaningful direction to score.
    if (sum.reduce((squared, value) => squared + value * value, 0) <= 1e-12)
      return unavailable
    try {
      if (!manager.addMulti({ name: callsign, v: embeddings }))
        return unavailable
      let lower = -1
      let upper = 1
      for (let i = 0; i < 25; i++) {
        const threshold = (lower + upper) / 2
        if (manager.verify({ name: callsign, v: query, threshold }))
          lower = threshold
        else
          upper = threshold
      }
      return { callsign, referenceSimilarity: (lower + upper) / 2, referenceRecordCount: embeddings.length }
    }
    catch { return unavailable }
    finally { manager.remove(callsign) }
  })
}
