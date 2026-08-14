<script setup lang="ts">
import type { PersistedSegment, SegmentPage } from '@iaxweb/contracts'
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useConditionalAutoRefresh } from '../composables/use-conditional-auto-refresh'

const PAGE_SIZE = 50
const CALLSIGN_PATTERN = /^(?:B[ADGHIY]\d[A-Z]{2,3}|N0CALL)$/
const CALLSIGN_HINT = '请输入 N0CALL，或 BA/BD/BG/BH/BI/BY + 数字 + 2–3 个字母'
const router = useRouter()
const statusMessage = ref('')
const segments = ref<PersistedSegment[]>([])
const currentPage = ref(1)
const pageInput = ref('1')
const total = ref(0)
const searchInput = ref('')
const callsignFilter = ref('')
const editingSegmentId = ref<string | null>(null)
const playingSegmentId = ref<string | null>(null)
const isLoading = ref(false)
const audioPlayer = new Audio()

const pageCount = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))
const { markRefreshed } = useConditionalAutoRefresh({
  canRefresh: () => currentPage.value === 1
    && editingSegmentId.value === null
    && searchInput.value === ''
    && callsignFilter.value === ''
    && !isLoading.value,
  refresh: loadSegments,
})

audioPlayer.addEventListener('ended', stopPlayback)
audioPlayer.addEventListener('error', handlePlaybackError)
onMounted(() => void loadSegments())
onBeforeUnmount(() => {
  stopPlayback()
  audioPlayer.removeEventListener('ended', stopPlayback)
  audioPlayer.removeEventListener('error', handlePlaybackError)
})

async function loadSegments(): Promise<void> {
  isLoading.value = true
  statusMessage.value = '加载中…'
  try {
    const query = new URLSearchParams({ page: String(currentPage.value), pageSize: String(PAGE_SIZE) })
    if (callsignFilter.value)
      query.set('callsign', callsignFilter.value)
    const response = await fetch(`/api/admin/segments?${query}`)
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
    const lastPage = Math.max(1, Math.ceil(data.total / PAGE_SIZE))
    if (currentPage.value > lastPage) {
      currentPage.value = lastPage
      pageInput.value = String(lastPage)
      await loadSegments()
      return
    }
    segments.value = data.items
    pageInput.value = String(currentPage.value)
    markRefreshed()
    statusMessage.value = callsignFilter.value
      ? `共 ${total.value} 条匹配记录`
      : `共 ${total.value} 条记录`
  }
  catch {
    statusMessage.value = '加载失败：无法连接服务器'
  }
  finally {
    isLoading.value = false
  }
}

async function changePage(nextPage: number): Promise<void> {
  currentPage.value = nextPage
  pageInput.value = String(nextPage)
  await loadSegments()
  window.scrollTo({ behavior: 'smooth', top: 0 })
}

async function goToPage(): Promise<void> {
  const requestedPage = Number(pageInput.value)
  if (!Number.isInteger(requestedPage)) {
    pageInput.value = String(currentPage.value)
    return
  }
  const nextPage = Math.min(Math.max(requestedPage, 1), pageCount.value)
  if (nextPage === currentPage.value) {
    pageInput.value = String(currentPage.value)
    return
  }
  await changePage(nextPage)
}

async function searchCallsign(): Promise<void> {
  const callsign = searchInput.value.trim().toUpperCase()
  searchInput.value = callsign
  if (callsign && !CALLSIGN_PATTERN.test(callsign)) {
    statusMessage.value = `搜索失败：${CALLSIGN_HINT}`
    return
  }
  callsignFilter.value = callsign
  currentPage.value = 1
  pageInput.value = '1'
  await loadSegments()
}

async function clearCallsignSearch(): Promise<void> {
  searchInput.value = ''
  callsignFilter.value = ''
  currentPage.value = 1
  pageInput.value = '1'
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

async function saveCallsign(segment: PersistedSegment, input: HTMLInputElement): Promise<boolean> {
  const callsign = input.value.trim().toUpperCase()
  if (callsign && !CALLSIGN_PATTERN.test(callsign)) {
    input.setCustomValidity(CALLSIGN_HINT)
    input.reportValidity()
    statusMessage.value = `保存失败：${CALLSIGN_HINT}`
    return false
  }
  input.setCustomValidity('')
  try {
    const response = await fetch(`/api/admin/segments/${encodeURIComponent(segment.id)}/manual-callsign`, {
      body: JSON.stringify({ callsign: callsign || null }),
      headers: { 'content-type': 'application/json' },
      method: 'PATCH',
    })
    if (!response.ok) {
      if (response.status === 401) {
        await router.replace('/')
        return false
      }
      statusMessage.value = '保存失败：呼号必须是规范呼号或 N0CALL'
      input.value = segment.effectiveCallsign ?? ''
      return false
    }
    const updatedSegment = await response.json() as PersistedSegment
    Object.assign(segment, updatedSegment)
    if (callsignFilter.value && updatedSegment.effectiveCallsign !== callsignFilter.value) {
      await loadSegments()
      return true
    }
    return true
  }
  catch {
    statusMessage.value = '保存失败：无法连接服务器'
    input.value = segment.effectiveCallsign ?? ''
    return false
  }
}

function beginCallsignEdit(event: MouseEvent, segment: PersistedSegment): void {
  const container = (event.currentTarget as HTMLElement).parentElement
  editingSegmentId.value = segment.id
  void nextTick(() => {
    const input = container?.querySelector<HTMLInputElement>('input')
    input?.focus()
    input?.select()
  })
}

function cancelCallsignEdit(segment: PersistedSegment, input: HTMLInputElement): void {
  input.value = segment.effectiveCallsign ?? ''
  if (editingSegmentId.value === segment.id)
    editingSegmentId.value = null
}

function normalizeCallsignInput(event: Event): void {
  const input = event.currentTarget as HTMLInputElement
  input.value = input.value.toUpperCase().replaceAll(/\s+/g, '')
  input.setCustomValidity(input.value.length === 0 || CALLSIGN_PATTERN.test(input.value) ? '' : CALLSIGN_HINT)
}

function normalizeSearchInput(event: Event): void {
  const input = event.currentTarget as HTMLInputElement
  input.value = input.value.toUpperCase().replaceAll(/\s+/g, '')
  searchInput.value = input.value
  input.setCustomValidity(input.value.length === 0 || CALLSIGN_PATTERN.test(input.value) ? '' : CALLSIGN_HINT)
}

async function onCallsignKeydown(event: KeyboardEvent, segment: PersistedSegment): Promise<void> {
  const input = event.currentTarget as HTMLInputElement
  if (event.key === 'Escape') {
    event.preventDefault()
    cancelCallsignEdit(segment, input)
    return
  }
  if (event.key !== 'Enter')
    return
  event.preventDefault()
  if (await saveCallsign(segment, input))
    editingSegmentId.value = null
}

function formatTime(iso: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'Asia/Shanghai' }).format(new Date(iso))
}
</script>

<template>
  <main class="min-h-dvh bg-slate-950 px-4 pb-4 text-slate-100 sm:px-6 lg:px-8">
    <section class="mx-auto max-w-screen-2xl">
      <header class="sticky top-0 z-10 -mx-4 mb-6 flex items-center justify-between gap-3 bg-slate-950/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <p class="shrink-0 whitespace-nowrap text-sm text-slate-400">
          {{ statusMessage }}
        </p>
        <form class="ml-auto flex min-w-0 items-center gap-2" role="search" @submit.prevent="searchCallsign">
          <input v-model="searchInput" lang="en" autocapitalize="characters" autocomplete="off" autocorrect="off" class="w-24 shrink-0 rounded-lg border border-slate-700 bg-slate-950 px-2 py-2 font-mono text-sm uppercase outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/20 sm:w-36 sm:px-3" inputmode="text" :pattern="CALLSIGN_PATTERN.source" placeholder="呼号搜索" aria-label="呼号搜索" spellcheck="false" @input="normalizeSearchInput">
          <button v-if="searchInput || callsignFilter" type="button" class="shrink-0 rounded-lg border border-slate-700 px-2 py-2 text-sm text-slate-300 transition hover:border-slate-500 hover:bg-slate-800 sm:px-3" @click="clearCallsignSearch">
            清除
          </button>
          <button type="submit" class="shrink-0 rounded-lg border border-slate-700 px-2 py-2 text-sm text-slate-300 transition hover:border-slate-500 hover:bg-slate-800 sm:px-4">
            搜索
          </button>
        </form>
      </header>
      <div class="space-y-3 md:hidden">
        <article v-for="segment in segments" :key="segment.id" class="rounded-xl border border-slate-800 bg-slate-900/70 p-4 shadow-xl shadow-black/20">
          <div class="flex items-start justify-between gap-3">
            <div>
              <p class="text-sm font-medium text-slate-200">
                {{ formatTime(segment.capturedAt) }}<span class="ml-3 text-xs font-normal text-slate-500">{{ (segment.durationMs / 1_000).toFixed(1) }}s</span>
              </p>
            </div><button v-if="canPlay(segment.capturedAt)" class="shrink-0 rounded-md border border-slate-700 px-3 py-1.5 text-xs transition hover:bg-slate-700" @click="togglePlayback(segment.id)">
              {{ playingSegmentId === segment.id ? '停止' : '播放' }}
            </button><span v-else class="shrink-0 text-xs text-slate-600">已过期</span>
          </div>
          <p class="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-200">
            {{ segment.recognition }}
          </p>
          <div class="mt-4 text-sm">
            <input v-if="editingSegmentId === segment.id" :value="segment.effectiveCallsign ?? ''" lang="en" autocapitalize="characters" autocomplete="off" autocorrect="off" class="h-[30px] w-full rounded-md border border-slate-700 bg-slate-950 px-2.5 py-0 font-mono uppercase outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/20" inputmode="text" :pattern="CALLSIGN_PATTERN.source" :title="CALLSIGN_HINT" aria-label="编辑呼号" spellcheck="false" @blur="cancelCallsignEdit(segment, $event.currentTarget as HTMLInputElement)" @input="normalizeCallsignInput" @keydown="onCallsignKeydown($event, segment)"><button v-else type="button" class="inline-flex h-[30px] cursor-text items-center font-mono hover:underline focus:outline-none focus:underline" :class="segment.manualCallsign !== null ? 'text-emerald-400' : segment.effectiveCallsign !== null ? 'text-cyan-300' : 'text-slate-500'" @click="beginCallsignEdit($event, segment)">
              {{ segment.effectiveCallsign ?? '—' }}
            </button>
          </div>
        </article>
      </div>
      <div class="hidden overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/70 shadow-xl shadow-black/20 md:block">
        <table class="min-w-[49rem] w-full table-fixed divide-y divide-slate-800 text-left text-sm leading-6">
          <colgroup><col class="w-44"><col class="w-16"><col><col class="w-40"><col class="w-24"></colgroup><thead class="bg-slate-900 text-xs uppercase tracking-wide text-slate-400">
            <tr>
              <th class="whitespace-nowrap px-4 py-3">
                时间
              </th><th class="whitespace-nowrap px-4 py-3">
                时长
              </th><th class="px-4 py-3">
                识别文本
              </th><th class="whitespace-nowrap px-4 py-3">
                呼号
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
              </td><td class="px-4 py-3">
                <input v-if="editingSegmentId === segment.id" :value="segment.effectiveCallsign ?? ''" lang="en" autocapitalize="characters" autocomplete="off" autocorrect="off" class="h-[30px] w-32 rounded-md border border-slate-700 bg-slate-950 px-2.5 py-0 font-mono uppercase outline-none focus:border-cyan-500" inputmode="text" :pattern="CALLSIGN_PATTERN.source" :title="CALLSIGN_HINT" aria-label="编辑呼号" spellcheck="false" @blur="cancelCallsignEdit(segment, $event.currentTarget as HTMLInputElement)" @input="normalizeCallsignInput" @keydown="onCallsignKeydown($event, segment)"><button v-else type="button" class="inline-flex h-[30px] cursor-text items-center font-mono hover:underline focus:outline-none focus:underline" :class="segment.manualCallsign !== null ? 'text-emerald-400' : segment.effectiveCallsign !== null ? 'text-cyan-300' : 'text-slate-500'" @click="beginCallsignEdit($event, segment)">
                  {{ segment.effectiveCallsign ?? '—' }}
                </button>
              </td><td class="px-4 py-3">
                <button v-if="canPlay(segment.capturedAt)" class="rounded-md border border-slate-700 px-3 py-1.5 text-xs transition hover:bg-slate-700" @click="togglePlayback(segment.id)">
                  {{ playingSegmentId === segment.id ? '停止' : '播放' }}
                </button><span v-else class="text-xs text-slate-600">已过期</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <nav class="sticky bottom-0 z-10 -mx-4 mt-5 flex flex-wrap items-center justify-center gap-2 border-t border-slate-800 bg-slate-950/95 px-3 py-2 text-xs backdrop-blur sm:-mx-6 sm:gap-3 sm:px-6 sm:py-3 sm:text-sm lg:-mx-8 lg:px-8">
        <button :disabled="currentPage <= 1" class="whitespace-nowrap rounded-lg border border-slate-700 px-2.5 py-1.5 disabled:cursor-not-allowed disabled:opacity-40 sm:px-4 sm:py-2" @click="changePage(currentPage - 1)">
          上一页
        </button><form class="flex items-center gap-1 text-slate-400 sm:gap-2" aria-label="页码跳转" @submit.prevent="goToPage">
          <span>第</span><input v-model="pageInput" type="number" min="1" :max="pageCount" class="w-12 rounded-md border border-slate-700 bg-slate-950 px-1 py-1 text-center text-slate-200 outline-none focus:border-cyan-500 sm:w-16 sm:px-2 sm:py-1.5" aria-label="页码"><span>/ {{ pageCount }} 页</span><button type="submit" class="rounded-md border border-slate-700 px-2 py-1 text-slate-300 transition hover:border-slate-500 hover:bg-slate-800 sm:px-3 sm:py-1.5">
            跳转
          </button>
        </form><button :disabled="currentPage >= pageCount" class="whitespace-nowrap rounded-lg border border-slate-700 px-2.5 py-1.5 disabled:cursor-not-allowed disabled:opacity-40 sm:px-4 sm:py-2" @click="changePage(currentPage + 1)">
          下一页
        </button>
      </nav>
    </section>
  </main>
</template>
