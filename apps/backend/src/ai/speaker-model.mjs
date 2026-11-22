export const SPEAKER_MODEL_NAME = '3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx'
export const SPEAKER_MODEL_SHA256 = 'bf1a75b9930474cf3389ef415e6e5d38ca96fea4a3a00f7e301d080a58ee2239'
export const SPEAKER_MODEL_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/${SPEAKER_MODEL_NAME}`
export const SPEAKER_DIMENSIONS = 192
// Only a speaker-model change invalidates stored embeddings. Keep the existing
// quality-v2 compatibility suffix: gate tuning must not trigger backfilling.
export const SPEAKER_VERSION = `${SPEAKER_MODEL_SHA256}:sherpa-2.0.1-native8k-v1:quality-v2`
