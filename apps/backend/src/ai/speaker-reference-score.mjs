import { SPEAKER_DIMENSIONS } from './speaker-model.mjs'

export const SPEAKER_REFERENCE_LIMIT = 16
const GROUP_SIMILARITY_THRESHOLD = 0.72
const MIN_REFERENCES_TO_GROUP = 5

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

function pairwiseSimilarities(embeddings, norms) {
  const similarities = embeddings.map(() => new Float64Array(embeddings.length))
  for (let i = 0; i < embeddings.length; i++) {
    for (let j = i + 1; j < embeddings.length; j++) {
      let dot = 0
      for (let k = 0; k < SPEAKER_DIMENSIONS; k++)
        dot += embeddings[i][k] * embeddings[j][k]
      const similarity = Math.max(-1, Math.min(1, dot / (norms[i] * norms[j])))
      similarities[i][j] = similarity
      similarities[j][i] = similarity
    }
  }
  return similarities
}

function trimReferences(embeddings, similarities) {
  const removeCount = Math.floor(embeddings.length / 5)
  const ranked = similarities.map((row, index) => {
    const scores = row.filter((_, other) => other !== index).sort()
    const middle = Math.floor(scores.length / 2)
    const median = scores.length % 2 ? scores[middle] : (scores[middle - 1] + scores[middle]) / 2
    return { index, median }
  })
  // References are ordered newest first. Discard the older entry on a tie.
  ranked.sort((a, b) => a.median - b.median || b.index - a.index)
  const removed = new Set(ranked.slice(0, removeCount).map(entry => entry.index))
  return embeddings.filter((_, index) => !removed.has(index))
}

// Reuses the pairwise matrix after trimming and updates it in place for linkage.
function clusterReferences(similarities) {
  const clusters = similarities.map((_, index) => [index])
  for (;;) {
    let best = GROUP_SIMILARITY_THRESHOLD
    let mergeLeft = -1
    let mergeRight = -1
    for (let i = 0; i < clusters.length; i++) {
      if (clusters[i].length === 0)
        continue
      for (let j = i + 1; j < clusters.length; j++) {
        if (clusters[j].length === 0)
          continue
        const similarity = similarities[i][j]
        if (similarity > best || (similarity === best && mergeLeft === -1)) {
          best = similarity
          mergeLeft = i
          mergeRight = j
        }
      }
    }
    if (mergeLeft === -1)
      break

    clusters[mergeLeft].push(...clusters[mergeRight])
    clusters[mergeRight] = []
    // Complete linkage uses the least similar pair across the merged groups.
    for (let i = 0; i < clusters.length; i++) {
      if (i === mergeLeft || clusters[i].length === 0)
        continue
      const similarity = Math.min(similarities[mergeLeft][i], similarities[mergeRight][i])
      similarities[mergeLeft][i] = similarity
      similarities[i][mergeLeft] = similarity
    }
  }

  return clusters.filter(cluster => cluster.length * 5 > similarities.length)
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
      referenceGroups: [],
    }
    if (embeddings.length === 0 || embeddings.length > SPEAKER_REFERENCE_LIMIT)
      return unavailable
    const norms = embeddings.map(vectorNorm)
    if (norms.includes(0))
      return unavailable

    const referenceSimilarity = scoreTemplate(manager, callsign, query, embeddings)
    const similarities = embeddings.length >= MIN_REFERENCES_TO_GROUP ? pairwiseSimilarities(embeddings, norms) : null
    const retained = similarities ? trimReferences(embeddings, similarities) : embeddings
    const trimmedReferenceSimilarity = similarities ? scoreTemplate(manager, callsign, query, retained) : referenceSimilarity
    const referenceGroups = similarities
      ? clusterReferences(similarities).flatMap((cluster) => {
          const similarity = cluster.length === embeddings.length
            ? referenceSimilarity
            : scoreTemplate(manager, callsign, query, cluster.map(index => embeddings[index]))
          return similarity === null ? [] : [{ similarity, recordCount: cluster.length }]
        }).sort((a, b) => b.recordCount - a.recordCount || b.similarity - a.similarity)
      : []
    return {
      callsign,
      referenceSimilarity,
      referenceRecordCount: referenceSimilarity === null ? 0 : embeddings.length,
      trimmedReferenceSimilarity,
      trimmedReferenceRecordCount: trimmedReferenceSimilarity === null ? 0 : retained.length,
      referenceGroups,
    }
  })
}
