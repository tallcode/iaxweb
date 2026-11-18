import { readFileSync } from 'node:fs'
import { freemem } from 'node:os'
import process from 'node:process'

const MIB = 1024 * 1024
export const SPEAKER_MAX_RSS = 2 * 1024 * MIB
// Retire after a successful large job instead of retaining its arena forever.
export const SPEAKER_RECYCLE_RSS = 1024 * MIB
export const SPEAKER_IDLE_TIMEOUT_MS = 5 * 60_000
export const SPEAKER_MIN_BUDGET = 384 * MIB
export const SPEAKER_MAX_AUDIO_MS = 60_000
export const SPEAKER_MAX_SAMPLES = SPEAKER_MAX_AUDIO_MS * 8
export const SPEAKER_TOO_LONG_REASON = 'audio_too_long_60s'
export const SPEAKER_RESOURCE_LIMIT_REASON = 'resource_limit_2g'

// Conservative admission estimate from full-record memory measurements. The
// live RSS/cgroup checks still enforce the actual budget during inference.
export function speakerRequiredMemory(samples: number): number {
  return Math.max(SPEAKER_MIN_BUDGET, (256 + 26 * samples / 8_000) * MIB)
}

function readNumber(filename: string): number | undefined {
  try {
    const number = Number(readFileSync(filename, 'utf8').trim())
    return Number.isFinite(number) && number >= 0 ? number : undefined
  }
  catch { return undefined }
}

export function speakerMemoryBudget(inFlightRss = 0): number {
  if (process.platform !== 'linux')
    return SPEAKER_MAX_RSS
  // MemAvailable includes reclaimable cache; MemFree alone is misleading.
  const available = /^MemAvailable:\s+(\d+) kB$/m.exec(readFileSync('/proc/meminfo', 'utf8'))
  let budget = (available ? Number(available[1]) * 1024 : freemem()) - 192 * MIB + inFlightRss
  for (const [limitFile, usageFile] of [
    ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory.current'],
    ['/sys/fs/cgroup/memory/memory.limit_in_bytes', '/sys/fs/cgroup/memory/memory.usage_in_bytes'],
  ] as const) {
    const limit = readNumber(limitFile)
    const usage = readNumber(usageFile)
    if (limit !== undefined && usage !== undefined)
      budget = Math.min(budget, limit - usage - 96 * MIB + inFlightRss)
  }
  return Math.min(SPEAKER_MAX_RSS, budget)
}

export function speakerProcessRss(pid: number): number | undefined {
  if (process.platform !== 'linux')
    return undefined
  try {
    const value = /^VmRSS:\s+(\d+) kB$/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))
    return value ? Number(value[1]) * 1024 : undefined
  }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return undefined
    throw error
  }
}
