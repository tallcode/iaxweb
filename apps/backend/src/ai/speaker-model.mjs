export const SPEAKER_MODEL_NAME = 'wespeaker_zh_cnceleb_resnet34_LM.onnx'
export const SPEAKER_MODEL_SHA256 = '87d1d5068397f3792c730570b53d66cd8be1da7ea22dd04f5b6706d96a3cd168'
export const SPEAKER_MODEL_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/${SPEAKER_MODEL_NAME}`
// Quality policy is part of the version: unchecked legacy vectors must not be
// compared with newly gated embeddings or treated as quality-checked history.
export const SPEAKER_VERSION = `${SPEAKER_MODEL_SHA256}:sherpa-2.0.1-native8k-v1:quality-v1`
