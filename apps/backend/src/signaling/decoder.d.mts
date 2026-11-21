import type { RadioSignal } from '@iaxweb/contracts'

export function signalingWindows(pcm: Int16Array): Int16Array[]
export function decodeSignaling(windows: Int16Array[]): readonly RadioSignal[]
