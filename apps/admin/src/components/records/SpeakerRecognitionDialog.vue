<script setup lang="ts">
import type { SpeakerMatch } from '@iaxweb/contracts'
import { computed, nextTick, ref, watch } from 'vue'
import { useSpeakerRecognitionContext } from '../../composables/records/use-records-context'

const recognition = useSpeakerRecognitionContext()
const { record, loading, result, error } = recognition.state
const dialog = ref<HTMLDialogElement>()
const totalMatches = computed(() => result.value?.matches.reduce((sum, match) => sum + match.count, 0) ?? 0)
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
  return value === null ? '—' : `${formatSimilarity(value)}/${count}`
}

function formatReferenceGroups(groups: Readonly<SpeakerMatch['referenceGroups']>): string {
  return groups.map(group => `${formatSimilarity(group.similarity)}(${group.recordCount})`).join('/') || '—'
}
</script>

<template>
  <dialog ref="dialog" aria-labelledby="speaker-recognition-title" class="m-auto max-h-[calc(100dvh_-_2rem)] w-[calc(100%_-_2rem)] max-w-3xl overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-5 text-slate-100 shadow-2xl backdrop:bg-slate-950/75 backdrop:backdrop-blur-sm sm:p-6" @cancel="recognition.close" @close="onClose">
    <div v-if="record">
      <h2 id="speaker-recognition-title" class="text-lg font-semibold">
        识别
      </h2>
      <div class="mt-5" aria-live="polite" :aria-busy="loading">
        <p v-if="loading" role="status" class="rounded-lg border border-cyan-900 bg-cyan-950/30 px-4 py-5 text-sm text-cyan-200">
          正在识别录音…
        </p>
        <p v-else-if="error" role="alert" class="rounded-lg border border-red-900 bg-red-950/30 px-4 py-4 text-sm text-red-300">
          {{ error }}
        </p>
        <template v-else-if="result">
          <p v-if="result.status === 'matched'" class="mb-3 text-sm text-slate-300">
            识别到 {{ totalMatches }} 条记录/{{ result.matches.length }} 个呼号
          </p>
          <div v-if="result.status === 'matched'" class="overflow-x-auto rounded-lg border border-slate-700">
            <table class="w-full whitespace-nowrap text-left text-xs tabular-nums sm:text-sm">
              <thead class="bg-slate-800/80 text-xs text-slate-400">
                <tr>
                  <th class="px-2 py-3 sm:px-3">
                    呼号
                  </th><th class="px-2 py-3 text-right sm:px-3">
                    <span class="sm:hidden">匹配数</span><span class="hidden sm:inline">匹配数量</span>
                  </th><th class="hidden px-3 py-3 text-right sm:table-cell">
                    <span class="sm:hidden">Max</span><span class="hidden sm:inline">最大值</span>
                  </th><th class="hidden px-3 py-3 text-right sm:table-cell">
                    <span class="sm:hidden">Min</span><span class="hidden sm:inline">最小值</span>
                  </th><th class="px-2 py-3 text-right sm:px-3" title="超过阈值的命中录音平均相似度">
                    <span class="sm:hidden">Avg</span><span class="hidden sm:inline">平均值</span>
                  </th><th class="px-2 py-3 text-right sm:px-3" title="合成相似度（百分制）/ 参考条数">
                    Syn
                  </th><th class="hidden px-3 py-3 text-right lg:table-cell" title="每组显示合成分数（参考条数），至少 5 条有效参考才分组">
                    合成组
                  </th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-800">
                <tr v-for="match in result.matches" :key="match.callsign">
                  <td class="px-2 py-3 font-mono font-medium text-cyan-300 sm:px-3">
                    {{ match.callsign }}
                  </td><td class="px-2 py-3 text-right sm:px-3">
                    {{ match.count }}
                  </td><td class="hidden px-3 py-3 text-right sm:table-cell">
                    {{ formatSimilarity(match.maxSimilarity) }}
                  </td><td class="hidden px-3 py-3 text-right sm:table-cell">
                    {{ formatSimilarity(match.minSimilarity) }}
                  </td><td class="px-2 py-3 text-right sm:px-3">
                    {{ formatSimilarity(match.averageSimilarity) }}
                  </td><td class="px-2 py-3 text-right text-cyan-200 sm:px-3">
                    {{ formatReferenceSimilarity(match.referenceSimilarity, match.referenceRecordCount) }}
                  </td><td class="hidden px-3 py-3 text-right text-cyan-200 lg:table-cell">
                    {{ formatReferenceGroups(match.referenceGroups) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else class="rounded-lg border border-amber-900/70 bg-amber-950/20 px-4 py-4 text-sm leading-6 text-amber-200">
            {{ result.reasonCode === 'below_threshold' ? '没有找到超过相似度阈值的已标注录音。' : result.reason }}
          </p>
        </template>
      </div>
      <div class="mt-6 flex justify-end gap-3">
        <button type="button" :disabled="loading" class="rounded-lg border border-slate-600 px-4 py-2 text-sm transition hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-cyan-500/50 disabled:opacity-40" @click="recognition.retry">
          重新识别
        </button>
        <button type="button" autofocus class="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-400/50" @click="close">
          关闭
        </button>
      </div>
    </div>
  </dialog>
</template>
