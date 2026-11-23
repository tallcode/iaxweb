import type { RecognitionRepository } from './ports.js'
import type { RecordingStore } from './recording-store.js'
import type { RecognitionRecord } from './types.js'

// A row becomes visible only after its WAV is written. Compensate for a failed
// insert by deleting the file created for this record.
export function saveRecognizedRecording(
  repository: Pick<RecognitionRepository, 'insert'>,
  recordings: Pick<RecordingStore, 'save' | 'remove'>,
  nodeId: string,
  record: RecognitionRecord,
  wav: Uint8Array,
): void {
  recordings.save(record.id, record.timestamp, wav)
  try {
    repository.insert(nodeId, record)
  }
  catch (error) {
    try {
      recordings.remove(record.id, record.timestamp)
    }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Failed to insert recording record and roll back WAV')
    }
    throw error
  }
}
