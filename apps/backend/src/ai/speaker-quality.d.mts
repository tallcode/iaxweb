import type { AudioInterferenceReason, AudioQuality } from '@iaxweb/contracts'

export type SpeakerQualityMetrics = NonNullable<AudioQuality['metrics']>

export type SpeakerQualityResult
  = | { accepted: true, metrics: SpeakerQualityMetrics }
    | { accepted: false, reason: 'invalid_audio' | 'insufficient_audio' | AudioInterferenceReason, metrics?: SpeakerQualityMetrics }

export function checkSpeakerQuality(samples: Float32Array): SpeakerQualityResult
export function checkLegacySpeakerQuality(samples: Float32Array): SpeakerQualityResult
