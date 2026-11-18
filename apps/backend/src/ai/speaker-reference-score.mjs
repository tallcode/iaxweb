import { SPEAKER_DIMENSIONS } from './speaker-model.mjs'

function vectorNorm(vector) {
  if (!(vector instanceof Float32Array) || vector.length !== SPEAKER_DIMENSIONS)
    return 0
  let squared = 0
  for (const value of vector) {
    if (!Number.isFinite(value))
      return 0
    squared += value * value
  }
  return Math.sqrt(squared)
}

function median(values) {
  values.sort((a, b) => a - b)
  const midpoint = Math.floor(values.length / 2)
  return values.length % 2 ? values[midpoint] : (values[midpoint - 1] + values[midpoint]) / 2
}

function trimReferences(embeddings, norms, removeCount) {
  const similarities = embeddings.map(() => [])
  for (let i = 0; i < embeddings.length; i++) {
    for (let j = i + 1; j < embeddings.length; j++) {
      let dot = 0
      for (let k = 0; k < SPEAKER_DIMENSIONS; k++)
        dot += embeddings[i][k] * embeddings[j][k]
      const similarity = Math.max(-1, Math.min(1, dot / (norms[i] * norms[j])))
      similarities[i].push(similarity)
      similarities[j].push(similarity)
    }
  }
  // The repository sends newest first, so drop older records first on ties.
  const ranked = similarities.map((scores, index) => ({ index, score: median(scores) }))
    .sort((a, b) => a.score - b.score || b.index - a.index)
  const removed = new Set(ranked.slice(0, removeCount).map(item => item.index))
  return embeddings.filter((_, index) => !removed.has(index))
}

// sherpa-onnx-node 2.0.1 exposes addMulti/verify, but no numeric score or
// centroid getter. Threshold bisection queries the actual native centroid;
// 25 iterations bound the score error to about 1e-7, well below UI precision.
function scoreTemplate(manager, callsign, query, embeddings) {
  const sum = new Float64Array(SPEAKER_DIMENSIONS)
  for (const embedding of embeddings) {
    for (let i = 0; i < SPEAKER_DIMENSIONS; i++)
      sum[i] += embedding[i]
  }
  // Opposing/degenerate references have no meaningful direction to score.
  if (sum.reduce((squared, value) => squared + value * value, 0) <= 1e-12)
    return null
  try {
    if (!manager.addMulti({ name: callsign, v: embeddings }))
      return null
    let lower = -1
    let upper = 1
    for (let i = 0; i < 25; i++) {
      const threshold = (lower + upper) / 2
      if (manager.verify({ name: callsign, v: query, threshold }))
        lower = threshold
      else
        upper = threshold
    }
    return (lower + upper) / 2
  }
  catch { return null }
  finally { manager.remove(callsign) }
}

export function scoreSpeakerReferences(sherpa, query, groups) {
  if (!vectorNorm(query))
    throw new Error('Invalid reference query vector')
  const manager = new sherpa.SpeakerEmbeddingManager(SPEAKER_DIMENSIONS)
  return groups.map(({ callsign, embeddings }) => {
    const unavailable = {
      callsign,
      referenceSimilarity: null,
      referenceRecordCount: 0,
      trimmedReferenceSimilarity: null,
      trimmedReferenceRecordCount: 0,
    }
    if (embeddings.length === 0 || embeddings.length > 10)
      return unavailable
    const norms = embeddings.map(vectorNorm)
    if (norms.includes(0))
      return unavailable

    const referenceSimilarity = scoreTemplate(manager, callsign, query, embeddings)
    const removeCount = Math.floor(embeddings.length / 5)
    const retained = removeCount === 0 ? embeddings : trimReferences(embeddings, norms, removeCount)
    const trimmedReferenceSimilarity = removeCount === 0 ? referenceSimilarity : scoreTemplate(manager, callsign, query, retained)
    return {
      callsign,
      referenceSimilarity,
      referenceRecordCount: referenceSimilarity === null ? 0 : embeddings.length,
      trimmedReferenceSimilarity,
      trimmedReferenceRecordCount: trimmedReferenceSimilarity === null ? 0 : retained.length,
    }
  })
}
