<script setup lang="ts">
import type { SpeakerMatch } from '@iaxweb/contracts'
import type { DeepReadonly } from 'vue'
import { computed, nextTick, ref, watch } from 'vue'
import { useSpeakerRecognitionContext } from '../../composables/records/use-records-context'

const recognition = useSpeakerRecognitionContext()
const { record, loading, result, error } = recognition.state
const dialog = ref<HTMLDialogElement>()
const totalMatches = computed(() => result.value?.matches.reduce((sum, match) => sum + match.count, 0) ?? 0)
const matchesWithStatus = computed(() => result.value?.matches.map(match => ({ match, status: recognitionStatus(match) })) ?? [])
const outcomeMessage = computed(() => {
  const reasonCode = result.value?.reasonCode
  if (reasonCode === 'interference_tone' || reasonCode === 'interference_high_band')
    return '无法启动呼号识别'
  return result.value?.status === 'no_match' ? '没有识别到呼号' : '无法识别呼号'
})
let previousFocus: HTMLElement | undefined
watch(record, async (value) => {
  if (!value)
    return
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  await nextTick()
  if (record.value && !dialog.value?.open)
    dialog.value?.showModal()
}, { flush: 'post' })

function close(): void {
  recognition.close()
  dialog.value?.close()
}
function onClose(): void {
  recognition.close()
  if (previousFocus?.isConnected)
    previousFocus.focus()
  previousFocus = undefined
}

function formatSimilarity(value: number): string {
  return (value * 100).toFixed(2)
}

function formatReferenceSimilarity(value: number | null, count: number): string {
  return value === null ? '—' : `${formatSimilarity(value)}(${count})`
}

function formatReferenceGroups(groups: Readonly<SpeakerMatch['referenceGroups']>): string {
  return [...groups]
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 2)
    .map(group => formatReferenceSimilarity(group.similarity, group.recordCount))
    .join('/') || '—'
}

function recognitionStatus(match: DeepReadonly<SpeakerMatch>): 'passed' | 'uncertain' | null {
  const scores = [
    { similarity: match.minSimilarity, recordCount: match.count },
    { similarity: match.referenceSimilarity, recordCount: match.referenceRecordCount },
    { similarity: match.trimmedReferenceSimilarity, recordCount: match.trimmedReferenceRecordCount },
    ...match.referenceGroups,
  ]
  let uncertain = false
  for (const { similarity, recordCount } of scores) {
    if (similarity === null || recordCount < 2)
      continue
    const passThreshold = recordCount >= 10 ? 0.80 : recordCount >= 5 ? 0.85 : 0.90
    if (similarity >= passThreshold)
      return 'passed'
    const uncertainThreshold = recordCount >= 5 ? 0.80 : 0.85
    if (similarity >= uncertainThreshold)
      uncertain = true
  }
  return uncertain ? 'uncertain' : null
}
</script>

<template>
  <dialog ref="dialog" aria-labelledby="speaker-recognition-title" class="m-auto max-h-[calc(100dvh_-_1rem)] w-[calc(100%_-_1rem)] max-w-2xl overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-3 text-slate-100 shadow-2xl backdrop:bg-slate-950/75 backdrop:backdrop-blur-sm sm:max-h-[calc(100dvh_-_2rem)] sm:w-[calc(100%_-_2rem)] sm:p-5" @cancel="recognition.close" @close="onClose">
    <div v-if="record">
      <h2 id="speaker-recognition-title" class="text-lg font-semibold">
        识别
      </h2>
      <div class="mt-5" aria-live="polite" :aria-busy="loading">
        <p v-if="loading" role="status" class="rounded-lg border border-cyan-900 bg-cyan-950/30 px-4 py-5 text-sm text-cyan-200">
          正在识别呼号…
        </p>
        <p v-else-if="error" role="alert" class="rounded-lg border border-red-900 bg-red-950/30 px-4 py-4 text-sm text-red-300">
          {{ error }}
        </p>
        <template v-else-if="result">
          <div v-if="result.status === 'matched'" class="overflow-x-auto rounded-lg border border-slate-700">
            <table class="w-full whitespace-nowrap text-left text-xs tabular-nums sm:text-sm">
              <thead class="bg-slate-800/80 text-xs text-slate-400">
                <tr>
                  <th class="w-6" aria-label="通过状态" /><th class="px-1.5 py-2.5 sm:px-2.5">
                    呼号
                  </th><th class="px-1.5 py-2.5 text-right sm:px-2.5">
                    独立
                  </th><th class="px-1.5 py-2.5 text-right sm:px-2.5" title="合成分数（参考条数）">
                    合成
                  </th><th class="hidden px-2.5 py-2.5 text-right lg:table-cell" title="每组分数（条数）">
                    分组合成
                  </th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-800">
                <tr v-for="{ match, status } in matchesWithStatus" :key="match.callsign">
                  <td class="px-1 py-2.5">
                    <svg v-if="status === 'passed'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="mx-auto size-4 text-emerald-400" role="img" aria-label="通过">
                      <path d="m5 12 4 4L19 6" />
                    </svg>
                    <svg v-else-if="status === 'uncertain'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="mx-auto size-4 text-yellow-400" role="img" aria-label="不确定">
                      <path d="M9 9a3 3 0 1 1 5 2.3c-1.2.9-2 1.3-2 2.7m0 4h.01" />
                    </svg>
                  </td><td class="px-1.5 py-2.5 font-mono font-medium text-cyan-300 sm:px-2.5">
                    {{ match.callsign }}
                  </td><td class="px-1.5 py-2.5 text-right sm:px-2.5">
                    {{ formatReferenceSimilarity(match.minSimilarity, match.count) }}
                  </td><td class="px-1.5 py-2.5 text-right text-cyan-200 sm:px-2.5">
                    {{ formatReferenceSimilarity(match.referenceSimilarity, match.referenceRecordCount) }}<span v-if="match.referenceRecordCount !== match.trimmedReferenceRecordCount" class="hidden lg:inline">/{{ formatReferenceSimilarity(match.trimmedReferenceSimilarity, match.trimmedReferenceRecordCount) }}</span>
                  </td><td class="hidden px-2.5 py-2.5 text-right text-cyan-200 lg:table-cell">
                    {{ formatReferenceGroups(match.referenceGroups) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else class="rounded-lg border border-amber-900/70 bg-amber-950/20 px-4 py-4 text-sm leading-6 text-amber-200">
            {{ outcomeMessage }}
          </p>
        </template>
      </div>
      <div class="mt-6 flex items-center gap-2 sm:gap-3">
        <div class="min-w-0 text-xs text-slate-300 sm:text-sm" aria-live="polite">
          <p v-if="result?.status === 'matched'">
            识别到 {{ totalMatches }} 条记录/{{ result.matches.length }} 个呼号
          </p>
        </div>
        <button type="button" autofocus class="ml-auto shrink-0 rounded-lg bg-cyan-600 px-3 py-2 text-sm font-medium whitespace-nowrap text-white transition hover:bg-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-400/50 sm:px-4" @click="close">
          关闭
        </button>
      </div>
    </div>
  </dialog>
</template>
