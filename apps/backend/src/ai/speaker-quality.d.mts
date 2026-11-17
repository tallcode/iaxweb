export interface SpeakerQualityMetrics {
  highBandFraction: number
  toneProminenceDb: number
}

export type SpeakerQualityResult
  = | { accepted: true, metrics: SpeakerQualityMetrics }
    | { accepted: false, reason: 'invalid_audio' | 'insufficient_audio' | 'interference_tone' | 'interference_high_band', metrics?: SpeakerQualityMetrics }

export function checkSpeakerQuality(samples: Float32Array): SpeakerQualityResult
