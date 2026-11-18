import type { SpeakerReferenceGroup, SpeakerReferenceScore } from '../records/types.js'

interface SpeakerManager {
  addMulti: (entry: { name: string, v: Float32Array[] }) => boolean
  verify: (entry: { name: string, v: Float32Array, threshold: number }) => boolean
  remove: (name: string) => boolean
}

export function scoreSpeakerReferences(
  sherpa: { SpeakerEmbeddingManager: new (dimensions: number) => SpeakerManager },
  query: Float32Array,
  groups: SpeakerReferenceGroup[],
): SpeakerReferenceScore[]
