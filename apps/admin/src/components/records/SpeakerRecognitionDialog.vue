<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useSpeakerRecognitionContext } from '../../composables/records/use-records-context'
import { formatRecordTime } from '../../utils/records-format'

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
</script>

<template>
  <dialog ref="dialog" aria-labelledby="speaker-recognition-title" class="m-auto max-h-[calc(100dvh_-_2rem)] w-[calc(100%_-_2rem)] max-w-2xl overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-5 text-slate-100 shadow-2xl backdrop:bg-slate-950/75 backdrop:backdrop-blur-sm sm:p-6" @cancel="recognition.close" @close="onClose">
    <div v-if="record">
      <h2 id="speaker-recognition-title" class="text-lg font-semibold">
        声纹识别 <span class="ml-2 rounded border border-cyan-800 bg-cyan-950/50 px-1.5 py-0.5 text-xs font-normal text-cyan-300">测试</span>
      </h2>
      <p class="mt-1 text-xs text-slate-400">
        {{ formatRecordTime(record.capturedAt) }} · {{ (record.durationMs / 1000).toFixed(1) }} 秒
      </p>
      <div class="mt-5" aria-live="polite" :aria-busy="loading">
        <p v-if="loading" role="status" class="rounded-lg border border-cyan-900 bg-cyan-950/30 px-4 py-5 text-sm text-cyan-200">
          正在检查录音质量并匹配声纹…
        </p>
        <p v-else-if="error" role="alert" class="rounded-lg border border-red-900 bg-red-950/30 px-4 py-4 text-sm text-red-300">
          {{ error }}
        </p>
        <template v-else-if="result">
          <p class="mb-3 text-sm text-slate-300">
            相似度 &gt; {{ result.threshold.toFixed(2) }}<template v-if="result.referenceCount !== null">
              · 参考录音 {{ result.referenceCount }} 条
            </template><template v-if="result.status === 'matched'">
              · 命中 {{ totalMatches }} 条 / {{ result.matches.length }} 个呼号
            </template>
          </p>
          <div v-if="result.status === 'matched'" class="overflow-x-auto rounded-lg border border-slate-700">
            <table class="w-full whitespace-nowrap text-left text-sm tabular-nums">
              <thead class="bg-slate-800/80 text-xs text-slate-400">
                <tr>
                  <th class="px-3 py-3">
                    呼号
                  </th><th class="px-3 py-3 text-right">
                    匹配数量
                  </th><th class="hidden px-3 py-3 text-right sm:table-cell">
                    最大值
                  </th><th class="hidden px-3 py-3 text-right sm:table-cell">
                    最小值
                  </th><th class="px-3 py-3 text-right">
                    平均值
                  </th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-800">
                <tr v-for="match in result.matches" :key="match.callsign">
                  <td class="px-3 py-3 font-mono font-medium text-cyan-300">
                    {{ match.callsign }}
                  </td><td class="px-3 py-3 text-right">
                    {{ match.count }}
                  </td><td class="hidden px-3 py-3 text-right sm:table-cell">
                    {{ match.maxSimilarity.toFixed(4) }}
                  </td><td class="hidden px-3 py-3 text-right sm:table-cell">
                    {{ match.minSimilarity.toFixed(4) }}
                  </td><td class="px-3 py-3 text-right">
                    {{ match.averageSimilarity.toFixed(4) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else class="rounded-lg border border-amber-900/70 bg-amber-950/20 px-4 py-4 text-sm leading-6 text-amber-200">
            {{ result.reason }}
          </p>
          <p v-if="result.status === 'matched'" class="mt-3 text-xs leading-5 text-slate-400">
            仅统计超过阈值的命中录音，按匹配数量排序。
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
