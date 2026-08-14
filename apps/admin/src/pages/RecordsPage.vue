<script setup lang="ts">
import type { PersistedSegment, SegmentPage } from '@iaxweb/contracts'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

const PAGE_SIZE = 50
const CALLSIGN_PATTERN = /^(?:B[ADGHIY]\d[A-Z]{2,3}|N0CALL)$/
const CALLSIGN_HINT = '请输入 N0CALL，或 BA/BD/BG/BH/BI/BY + 数字 + 2–3 个字母'
const router = useRouter()
const statusMessage = ref('')
const segments = ref<PersistedSegment[]>([])
const currentPage = ref(1)
const total = ref(0)
const playingSegmentId = ref<string | null>(null)
const audioPlayer = new Audio()

const pageCount = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))

audioPlayer.addEventListener('ended', stopPlayback)
audioPlayer.addEventListener('error', handlePlaybackError)
onMounted(() => void loadSegments())
onBeforeUnmount(() => {
  stopPlayback()
  audioPlayer.removeEventListener('ended', stopPlayback)
  audioPlayer.removeEventListener('error', handlePlaybackError)
})

async function logout(): Promise<void> {
  await fetch('/api/admin/logout', { method: 'POST' })
  stopPlayback()
  await router.replace('/')
}

async function loadSegments(): Promise<void> {
  statusMessage.value = '加载中…'
  const response = await fetch(`/api/admin/segments?page=${currentPage.value}&pageSize=${PAGE_SIZE}`)
  if (response.status === 401) {
    await router.replace('/')
    return
  }
  if (!response.ok) {
    statusMessage.value = response.status === 503 ? '持久化未启用' : '加载失败'
    return
  }
  const data = await response.json() as SegmentPage
  total.value = data.total
  segments.value = data.items
  statusMessage.value = total.value === 0 ? '暂无记录' : `共 ${total.value} 条记录`
}

async function changePage(nextPage: number): Promise<void> {
  currentPage.value = nextPage
  await loadSegments()
}

async function togglePlayback(id: string): Promise<void> {
  if (playingSegmentId.value === id) {
    stopPlayback()
    return
  }
  stopPlayback()
  playingSegmentId.value = id
  audioPlayer.src = `/api/admin/segments/${encodeURIComponent(id)}/audio`
  try {
    await audioPlayer.play()
  }
  catch {
    handlePlaybackError()
  }
}

function stopPlayback(): void {
  audioPlayer.pause()
  audioPlayer.removeAttribute('src')
  audioPlayer.load()
  playingSegmentId.value = null
}

function handlePlaybackError(): void {
  stopPlayback()
  statusMessage.value = '播放失败：录音可能已被清理'
}

function canPlay(capturedAt: string): boolean {
  const ageMs = Date.now() - new Date(capturedAt).getTime()
  return ageMs >= 0 && ageMs < 30 * 24 * 60 * 60 * 1_000
}

async function saveCallsign(segment: PersistedSegment, input: HTMLInputElement): Promise<void> {
  const callsign = input.value.trim().toUpperCase()
  if (callsign && !CALLSIGN_PATTERN.test(callsign)) {
    input.setCustomValidity(CALLSIGN_HINT)
    input.reportValidity()
    statusMessage.value = `保存失败：${CALLSIGN_HINT}`
    return
  }
  input.setCustomValidity('')
  const response = await fetch(`/api/admin/segments/${encodeURIComponent(segment.id)}/manual-callsign`, {
    body: JSON.stringify({ callsign: callsign || null }),
    headers: { 'content-type': 'application/json' },
    method: 'PATCH',
  })
  if (!response.ok) {
    statusMessage.value = '保存失败：呼号必须是规范呼号或 N0CALL'
    input.value = segment.manualCallsign ?? ''
    return
  }
  segment.manualCallsign = callsign || null
  input.value = callsign
  statusMessage.value = '已保存'
}

function normalizeCallsignInput(event: Event): void {
  const input = event.currentTarget as HTMLInputElement
  input.value = input.value.toUpperCase().replaceAll(/\s+/g, '')
  input.setCustomValidity(input.value.length === 0 || CALLSIGN_PATTERN.test(input.value) ? '' : CALLSIGN_HINT)
}

function onCallsignKeydown(event: KeyboardEvent, segment: PersistedSegment): void {
  if (event.key !== 'Enter')
    return
  event.preventDefault()
  void saveCallsign(segment, event.currentTarget as HTMLInputElement)
}

function formatTime(iso: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'Asia/Shanghai' }).format(new Date(iso))
}
</script>

<template>
  <main class="min-h-dvh bg-slate-950 px-4 py-10 text-slate-100 sm:px-6 lg:px-8">
    <section class="mx-auto max-w-screen-2xl">
      <header class="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 class="text-2xl font-semibold tracking-tight">
            AI 识别记录
          </h1>
          <p class="mt-1 text-sm text-slate-400">
            {{ statusMessage }}
          </p>
        </div>
        <button class="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 transition hover:border-slate-500 hover:bg-slate-800" @click="logout">
          退出
        </button>
      </header>
      <div class="space-y-3 md:hidden">
        <article v-for="segment in segments" :key="segment.id" class="rounded-xl border border-slate-800 bg-slate-900/70 p-4 shadow-xl shadow-black/20">
          <div class="flex items-start justify-between gap-3">
            <div>
              <p class="text-sm font-medium text-slate-200">
                {{ formatTime(segment.capturedAt) }}
              </p><p class="mt-1 text-xs text-slate-500">
                时长 {{ (segment.durationMs / 1_000).toFixed(1) }}s
              </p>
            </div><button v-if="canPlay(segment.capturedAt)" class="shrink-0 rounded-md border border-slate-700 px-3 py-1.5 text-xs transition hover:bg-slate-700" @click="togglePlayback(segment.id)">
              {{ playingSegmentId === segment.id ? '停止' : '播放' }}
            </button><span v-else class="shrink-0 text-xs text-slate-600">已过期</span>
          </div>
          <p class="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-200">
            {{ segment.recognition }}
          </p>
          <dl class="mt-4 grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt class="text-xs text-slate-500">
                AI 呼号
              </dt><dd class="mt-1 font-mono text-cyan-300">
                {{ segment.callsign ?? '—' }}
              </dd>
            </div><div>
              <dt class="text-xs text-slate-500">
                人工复核呼号
              </dt><dd class="mt-1">
                <input :value="segment.manualCallsign ?? ''" autocapitalize="characters" class="w-full rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 font-mono uppercase outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/20" inputmode="text" :pattern="CALLSIGN_PATTERN.source" :title="CALLSIGN_HINT" aria-label="人工复核呼号" @blur="($event.currentTarget as HTMLInputElement).value = segment.manualCallsign ?? ''" @input="normalizeCallsignInput" @keydown="onCallsignKeydown($event, segment)">
              </dd>
            </div>
          </dl>
          <p class="mt-2 text-xs text-slate-500">
            {{ CALLSIGN_HINT }}；留空可撤销人工复核。
          </p>
        </article>
      </div>
      <div class="hidden overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/70 shadow-xl shadow-black/20 md:block">
        <table class="min-w-[57rem] w-full table-fixed divide-y divide-slate-800 text-left text-sm leading-6">
          <colgroup><col class="w-44"><col class="w-16"><col><col class="w-28"><col class="w-40"><col class="w-24"></colgroup><thead class="bg-slate-900 text-xs uppercase tracking-wide text-slate-400">
            <tr>
              <th class="whitespace-nowrap px-4 py-3">
                时间
              </th><th class="whitespace-nowrap px-4 py-3">
                时长
              </th><th class="px-4 py-3">
                识别文本
              </th><th class="whitespace-nowrap px-4 py-3">
                AI 呼号
              </th><th class="whitespace-nowrap px-4 py-3">
                人工复核呼号
              </th><th class="whitespace-nowrap px-4 py-3">
                播放
              </th>
            </tr>
          </thead><tbody class="divide-y divide-slate-800/80">
            <tr v-for="segment in segments" :key="segment.id" class="align-top transition hover:bg-slate-800/40">
              <td class="whitespace-nowrap px-4 py-3 text-slate-400">
                {{ formatTime(segment.capturedAt) }}
              </td><td class="whitespace-nowrap px-4 py-3">
                {{ (segment.durationMs / 1_000).toFixed(1) }}s
              </td><td class="px-4 py-3">
                {{ segment.recognition }}
              </td><td class="whitespace-nowrap px-4 py-3 font-mono text-cyan-300">
                {{ segment.callsign ?? '' }}
              </td><td class="px-4 py-3">
                <input :value="segment.manualCallsign ?? ''" autocapitalize="characters" class="w-32 rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 font-mono uppercase outline-none focus:border-cyan-500" inputmode="text" :pattern="CALLSIGN_PATTERN.source" :title="CALLSIGN_HINT" aria-label="人工复核呼号" @blur="($event.currentTarget as HTMLInputElement).value = segment.manualCallsign ?? ''" @input="normalizeCallsignInput" @keydown="onCallsignKeydown($event, segment)">
              </td><td class="px-4 py-3">
                <button v-if="canPlay(segment.capturedAt)" class="rounded-md border border-slate-700 px-3 py-1.5 text-xs transition hover:bg-slate-700" @click="togglePlayback(segment.id)">
                  {{ playingSegmentId === segment.id ? '停止' : '播放' }}
                </button><span v-else class="text-xs text-slate-600">已过期</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <nav class="mt-5 flex items-center justify-center gap-4 text-sm">
        <button :disabled="currentPage <= 1" class="rounded-lg border border-slate-700 px-4 py-2 disabled:cursor-not-allowed disabled:opacity-40" @click="changePage(currentPage - 1)">
          上一页
        </button><span class="text-slate-400">第 {{ currentPage }} 页 / {{ pageCount }} 页</span><button :disabled="currentPage >= pageCount" class="rounded-lg border border-slate-700 px-4 py-2 disabled:cursor-not-allowed disabled:opacity-40" @click="changePage(currentPage + 1)">
          下一页
        </button>
      </nav>
    </section>
  </main>
</template>
