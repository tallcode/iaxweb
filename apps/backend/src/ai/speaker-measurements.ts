import type { SpeakerRecognitionMeasurements } from '@iaxweb/contracts'

export const SPEAKER_WORKER_MEASUREMENT_STAGES = [
  'qualityCheckMs',
  'modelValidationMs',
  'nativeLibraryLoadMs',
  'modelLoadMs',
  'featureExtractionMs',
  'embeddingComputeMs',
  'embeddingNormalizeMs',
] as const

export type SpeakerWorkerMeasurementStage = typeof SPEAKER_WORKER_MEASUREMENT_STAGES[number]

export function createSpeakerMeasurements(): SpeakerRecognitionMeasurements {
  return {
    totalMs: 0,
    recordLookupMs: null,
    audioReadMs: null,
    queueWaitMs: null,
    processStartupMs: null,
    qualityCheckMs: null,
    modelValidationMs: null,
    nativeLibraryLoadMs: null,
    modelLoadMs: null,
    featureExtractionMs: null,
    embeddingComputeMs: null,
    embeddingNormalizeMs: null,
    processExitMs: null,
    processTotalMs: null,
    databaseSearchMs: null,
  }
}
