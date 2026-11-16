<script setup lang="ts">
import type { AdminRole, AdminSegmentPage, PersistedSegment } from '@iaxweb/contracts'
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import AdminPageHeader from '../components/AdminPageHeader.vue'
import CallsignText from '../components/CallsignText.vue'
import RecognitionEditor from '../components/RecognitionEditor.vue'
import ReviewStar from '../components/ReviewStar.vue'
import { useConditionalAutoRefresh } from '../composables/use-conditional-auto-refresh'

const PAGE_SIZE = 50
const CALLSIGN_PATTERN = /^(?:B[ADGHIY]\d[A-Z]{2,3}|N0CALL)$/
const CALLSIGN_HINT = '请输入 N0CALL，或 BA/BD/BG/BH/BI/BY + 数字 + 2–3 个字母'
const router = useRouter()
const statusMessage = ref('')
const segments = ref<PersistedSegment[]>([])
const recordingDates = ref(new Set<string>())
const userRole = ref<AdminRole>('viewer')
const username = ref('')
const loggingOut = ref(false)
const canEdit = computed(() => userRole.value === 'admin' || userRole.value === 'editor')
const isAdministrator = computed(() => userRole.value === 'admin')
const currentPage = ref(1)
const pageInput = ref('1')
const total = ref(0)
const searchInput = ref('')
const callsignFilter = ref('')
const editedOnly = ref(false)
const reviewedOnly = ref(false)
type CallsignRole = 'callee' | 'caller'
const editingCallsign = ref<{ id: string, role: CallsignRole } | null>(null)
const textEditors = ref(0)
const savingSegments = ref(new Set<string>())
const deletingSegmentId = ref<string | null>(null)
const pendingDeletion = ref<PersistedSegment | null>(null)
const deleteDialog = ref<HTMLDialogElement>()
const deleteError = ref('')
const searchField = ref<HTMLInputElement>()
const playingSegmentId = ref<string | null>(null)
const isLoading = ref(false)
const audioPlayer = new Audio()
let segmentRequest: AbortController | undefined
let deleteTrigger: HTMLButtonElement | undefined

const pageCount = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))
const isRecordSummary = computed(() => /^共 \d+ 条(?:匹配)?记录$/.test(statusMessage.value))
const compactStatus = computed(() => {
  if (isLoading.value)
    return '加载中'
  if (!isRecordSummary.value)
    return '提示'
  const count = total.value < 10_000 ? String(total.value) : `${Number((total.value / 10_000).toFixed(1))}万`
  return `${count}条`
})
const { markRefreshed } = useConditionalAutoRefresh({
  canRefresh: () => currentPage.value === 1
    && !loggingOut.value
    && editingCallsign.value === null
    && textEditors.value === 0
    && savingSegments.value.size === 0
    && pendingDeletion.value === null
    && searchInput.value === ''
    && callsignFilter.value === ''
    && !editedOnly.value
    && !reviewedOnly.value
    && !isLoading.value,
  refresh: loadSegments,
})

audioPlayer.addEventListener('ended', stopPlayback)
audioPlayer.addEventListener('error', handlePlaybackError)
onMounted(() => void loadSegments())
onBeforeUnmount(() => {
  segmentRequest?.abort()
  stopPlayback()
  audioPlayer.removeEventListener('ended', stopPlayback)
  audioPlayer.removeEventListener('error', handlePlaybackError)
})

async function loadSegments(): Promise<void> {
  segmentRequest?.abort()
  const request = new AbortController()
  segmentRequest = request
  isLoading.value = true
  statusMessage.value = '加载中…'
  try {
    const query = new URLSearchParams({ page: String(currentPage.value), pageSize: String(PAGE_SIZE) })
    if (callsignFilter.value)
      query.set('callsign', callsignFilter.value)
    if (editedOnly.value)
      query.set('editedOnly', 'true')
    if (reviewedOnly.value)
      query.set('reviewedOnly', 'true')
    const response = await fetch(`/api/admin/segments?${query}`, { signal: request.signal })
    if (request.signal.aborted)
      return
    if (response.status === 401) {
      await router.replace('/')
      return
    }
    if (!response.ok) {
      statusMessage.value = response.status === 503 ? '持久化未启用' : '加载失败'
      return
    }
    const data = await response.json() as AdminSegmentPage
    if (request.signal.aborted)
      return
    total.value = data.total
    const lastPage = Math.max(1, Math.ceil(data.total / PAGE_SIZE))
    if (currentPage.value > lastPage) {
      currentPage.value = lastPage
      pageInput.value = String(lastPage)
      await loadSegments()
      return
    }
    segments.value = data.items
    recordingDates.value = new Set(data.recordingDates)
    userRole.value = data.user?.role ?? 'viewer'
    username.value = data.user?.username ?? ''
    pageInput.value = String(currentPage.value)
    markRefreshed()
    statusMessage.value = callsignFilter.value || editedOnly.value || reviewedOnly.value
      ? `共 ${total.value} 条匹配记录`
      : `共 ${total.value} 条记录`
  }
  catch {
    if (!request.signal.aborted)
      statusMessage.value = '加载失败：无法连接服务器'
  }
  finally {
    if (segmentRequest === request) {
      isLoading.value = false
      segmentRequest = undefined
    }
  }
}

function scrollToPageTop(): void {
  window.scrollTo({ behavior: 'smooth', top: 0 })
}

async function logout(): Promise<void> {
  if (loggingOut.value || savingSegments.value.size > 0)
    return
  loggingOut.value = true
  segmentRequest?.abort()
  stopPlayback()
  try {
    const response = await fetch('/api/admin/logout', { method: 'POST' })
    if (!response.ok && response.status !== 401) {
      statusMessage.value = '注销失败，请重试'
      return
    }
    username.value = ''
    userRole.value = 'viewer'
    segments.value = []
    total.value = 0
    await router.replace('/')
  }
  catch {
    statusMessage.value = '注销失败：无法连接服务器'
  }
  finally {
    loggingOut.value = false
  }
}

async function changePage(nextPage: number): Promise<void> {
  currentPage.value = nextPage
  pageInput.value = String(nextPage)
  await loadSegments()
  scrollToPageTop()
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
  scrollToPageTop()
}

async function applyFilters(): Promise<void> {
  currentPage.value = 1
  pageInput.value = '1'
  await loadSegments()
  scrollToPageTop()
}

function matchesFilters(segment: PersistedSegment): boolean {
  const edited = segment.manualRecognition !== null || segment.manualCallsign !== null || segment.calleeCallsign !== null
  return (!callsignFilter.value || segment.effectiveCallsign === callsignFilter.value)
    && (!editedOnly.value || edited)
    && (!reviewedOnly.value || segment.reviewed)
}

async function clearCallsignSearch(): Promise<void> {
  searchInput.value = ''
  callsignFilter.value = ''
  editedOnly.value = false
  reviewedOnly.value = false
  currentPage.value = 1
  pageInput.value = '1'
  await loadSegments()
  scrollToPageTop()
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

async function requestDeletion(segment: PersistedSegment, event: MouseEvent): Promise<void> {
  if (!isAdministrator.value || pendingDeletion.value || savingSegments.value.size > 0 || textEditors.value > 0 || editingCallsign.value !== null)
    return
  segmentRequest?.abort()
  deleteTrigger = event.currentTarget as HTMLButtonElement
  pendingDeletion.value = segment
  deleteError.value = ''
  await nextTick()
  if (deleteDialog.value) {
    deleteDialog.value.returnValue = ''
    deleteDialog.value.showModal()
  }
}

function closeDeleteDialog(): void {
  if (deletingSegmentId.value === null)
    deleteDialog.value?.close()
}

function onDeleteDialogCancel(event: Event): void {
  if (deletingSegmentId.value !== null)
    event.preventDefault()
}

function onDeleteDialogClose(): void {
  pendingDeletion.value = null
  deleteError.value = ''
  if (deleteDialog.value?.returnValue !== 'deleted' && deleteTrigger?.isConnected && deleteTrigger.getClientRects().length > 0)
    deleteTrigger.focus()
  else
    searchField.value?.focus()
  deleteTrigger = undefined
}

async function deleteSegment(): Promise<void> {
  const segment = pendingDeletion.value
  if (!segment || !isAdministrator.value || deletingSegmentId.value !== null)
    return
  deleteError.value = ''
  savingSegments.value.add(segment.id)
  deletingSegmentId.value = segment.id
  segmentRequest?.abort()
  try {
    const response = await fetch(`/api/admin/segments/${encodeURIComponent(segment.id)}`, { method: 'DELETE' })
    if (response.status === 401) {
      deleteDialog.value?.close()
      await router.replace('/')
      return
    }
    if (!response.ok && response.status !== 404) {
      deleteError.value = '删除失败，请稍后重试'
      statusMessage.value = deleteError.value
      return
    }
    if (playingSegmentId.value === segment.id)
      stopPlayback()
    segments.value = segments.value.filter(row => row.id !== segment.id)
    total.value = Math.max(0, total.value - 1)
    await loadSegments()
    deleteDialog.value?.close('deleted')
  }
  catch {
    deleteError.value = '删除失败：无法连接服务器'
    statusMessage.value = deleteError.value
  }
  finally {
    savingSegments.value.delete(segment.id)
    deletingSegmentId.value = null
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
  return recordingDates.value.has(capturedAt.slice(0, 10).replaceAll('-', ''))
}

function callsignFor(segment: PersistedSegment, role: CallsignRole): string | null {
  return role === 'callee' ? segment.calleeCallsign : segment.effectiveCallsign
}

function isEditingCallsign(segment: PersistedSegment, role: CallsignRole): boolean {
  return editingCallsign.value?.id === segment.id && editingCallsign.value.role === role
}

function onTextEditing(editing: boolean): void {
  textEditors.value += editing ? 1 : -1
  if (editing)
    segmentRequest?.abort()
}

async function patchSegment(segment: PersistedSegment, endpoint: string, body: unknown): Promise<PersistedSegment | undefined> {
  if (!canEdit.value || savingSegments.value.has(segment.id) || deletingSegmentId.value !== null)
    return undefined
  savingSegments.value.add(segment.id)
  segmentRequest?.abort()
  try {
    const response = await fetch(`/api/admin/segments/${encodeURIComponent(segment.id)}/${endpoint}`, {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      method: 'PATCH',
    })
    if (response.status === 401) {
      await router.replace('/')
      return undefined
    }
    if (!response.ok) {
      statusMessage.value = response.status === 404 ? '保存失败：记录不存在' : '保存失败，请检查输入后重试'
      return undefined
    }
    const updated = await response.json() as PersistedSegment
    segmentRequest?.abort()
    Object.assign(segment, updated)
    const visible = segments.value.find(row => row.id === segment.id)
    if (visible && visible !== segment)
      Object.assign(visible, updated)
    statusMessage.value = callsignFilter.value || editedOnly.value || reviewedOnly.value
      ? `共 ${total.value} 条匹配记录`
      : `共 ${total.value} 条记录`
    if (!matchesFilters(updated))
      await loadSegments()
    return updated
  }
  catch {
    statusMessage.value = '保存失败：无法连接服务器'
    return undefined
  }
  finally {
    savingSegments.value.delete(segment.id)
  }
}

async function saveRecognition(segment: PersistedSegment, recognition: string | null): Promise<boolean> {
  return !!await patchSegment(segment, 'manual-recognition', { recognition })
}

async function setReviewed(segment: PersistedSegment, reviewed: boolean): Promise<void> {
  if (!isAdministrator.value)
    return
  await patchSegment(segment, 'manual-review', { reviewed })
}

async function saveCallsign(segment: PersistedSegment, role: CallsignRole, input: HTMLInputElement): Promise<boolean> {
  const callsign = input.value.trim().toUpperCase()
  if (callsign && !CALLSIGN_PATTERN.test(callsign)) {
    input.setCustomValidity(CALLSIGN_HINT)
    input.reportValidity()
    statusMessage.value = `保存失败：${CALLSIGN_HINT}`
    return false
  }
  input.setCustomValidity('')
  const endpoint = role === 'callee' ? 'manual-callee-callsign' : 'manual-callsign'
  const updatedSegment = await patchSegment(segment, endpoint, { callsign: callsign || null })
  if (!updatedSegment)
    return false
  return true
}

function beginCallsignEdit(event: MouseEvent, segment: PersistedSegment, role: CallsignRole): void {
  if (!canEdit.value || savingSegments.value.has(segment.id) || deletingSegmentId.value !== null)
    return
  segmentRequest?.abort()
  const container = (event.currentTarget as HTMLElement).parentElement
  editingCallsign.value = { id: segment.id, role }
  void nextTick(() => {
    const input = container?.querySelector<HTMLInputElement>('input')
    input?.focus()
    input?.select()
  })
}

function cancelCallsignEdit(segment: PersistedSegment, role: CallsignRole, input: HTMLInputElement): void {
  input.value = callsignFor(segment, role) ?? ''
  if (isEditingCallsign(segment, role))
    editingCallsign.value = null
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

async function onCallsignKeydown(event: KeyboardEvent, segment: PersistedSegment, role: CallsignRole): Promise<void> {
  const input = event.currentTarget as HTMLInputElement
  if (event.key === 'Escape') {
    event.preventDefault()
    cancelCallsignEdit(segment, role, input)
    return
  }
  if (event.key !== 'Enter')
    return
  event.preventDefault()
  if (await saveCallsign(segment, role, input))
    editingCallsign.value = null
}

function formatTime(iso: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'Asia/Shanghai' }).format(new Date(iso))
}
</script>

<template>
  <div class="min-h-dvh min-w-[380px] bg-slate-950 text-slate-100">
    <AdminPageHeader title="记录管理" :username="username" :logging-out="loggingOut" :disabled="savingSegments.size > 0" @logout="logout">
      <RouterLink v-if="isAdministrator" to="/users" class="shrink-0 text-xs text-slate-400 transition hover:text-slate-100 sm:text-sm">
        用户管理
      </RouterLink>
    </AdminPageHeader>
    <main :inert="loggingOut" class="mx-auto w-full max-w-screen-2xl px-4 pt-16 pb-4 sm:px-6 lg:px-8">
      <div class="sticky top-16 z-20 -mx-4 flex h-16 flex-nowrap items-center justify-between gap-3 bg-slate-950/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <p class="shrink-0 whitespace-nowrap text-sm text-slate-400" :title="statusMessage" :aria-label="statusMessage">
          <span class="sm:hidden">{{ compactStatus }}</span>
          <span class="hidden sm:inline">{{ statusMessage }}</span>
        </p>
        <form class="ml-auto flex shrink-0 flex-nowrap items-center justify-end gap-3" role="search" @submit.prevent="searchCallsign">
          <div class="flex items-center gap-3">
            <label class="flex min-h-10 shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap text-sm text-slate-300"><input v-model="editedOnly" type="checkbox" class="size-3.5 shrink-0 accent-cyan-500" aria-label="筛选已编辑" @change="applyFilters">已编辑</label>
            <label class="flex min-h-10 shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap text-sm text-slate-300"><input v-model="reviewedOnly" type="checkbox" class="size-3.5 shrink-0 accent-cyan-500" aria-label="筛选已标注" @change="applyFilters">已标注</label>
          </div>
          <div class="flex items-center gap-2">
            <input ref="searchField" v-model="searchInput" lang="en" autocapitalize="characters" autocomplete="off" autocorrect="off" class="w-[calc(8ch+1.5rem+2px)] flex-none rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm uppercase outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/20 sm:w-[calc(16ch+1.5rem+2px)]" inputmode="text" :pattern="CALLSIGN_PATTERN.source" placeholder="呼号" aria-label="呼号搜索" spellcheck="false" @input="normalizeSearchInput">
            <button v-if="searchInput || callsignFilter || editedOnly || reviewedOnly" type="button" aria-label="清除" title="清除搜索和筛选" class="inline-flex shrink-0 items-center justify-center rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 transition hover:border-slate-500 hover:bg-slate-800 focus:outline-none" @click="clearCallsignSearch">
              清除
            </button>
            <button type="submit" aria-label="搜索" title="搜索" class="inline-flex shrink-0 items-center justify-center rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 transition hover:border-slate-500 hover:bg-slate-800 focus:outline-none">
              搜索
            </button>
          </div>
        </form>
        <p v-if="statusMessage && !isRecordSummary && !isLoading" role="status" class="w-full break-words text-xs text-amber-300 sm:hidden">
          {{ statusMessage }}
        </p>
      </div>
      <div role="region" aria-label="识别记录">
        <div class="space-y-3 md:hidden">
          <article v-for="segment in segments" :key="segment.id" class="rounded-xl border p-4 shadow-xl shadow-black/20" :class="segment.reviewed ? 'border-emerald-800/60 bg-emerald-950/40' : 'border-slate-800 bg-slate-900/70'">
            <div class="flex items-center justify-between gap-3">
              <div class="min-w-0">
                <p class="text-sm font-medium text-slate-200">
                  {{ formatTime(segment.capturedAt) }}<span class="ml-3 text-xs font-normal text-slate-500">{{ (segment.durationMs / 1_000).toFixed(1) }}s</span>
                </p>
              </div><div class="flex shrink-0 items-center gap-3">
                <button v-if="canPlay(segment.capturedAt)" class="shrink-0 rounded-md border border-slate-700 px-3 py-1.5 text-xs transition hover:bg-slate-700" @click="togglePlayback(segment.id)">
                  {{ playingSegmentId === segment.id ? '停止' : '播放' }}
                </button><span v-else class="shrink-0 text-xs text-slate-600">已过期</span>
                <ReviewStar v-if="isAdministrator" :reviewed="segment.reviewed" :disabled="savingSegments.has(segment.id) || deletingSegmentId !== null || textEditors > 0 || editingCallsign !== null" @toggle="setReviewed(segment, !segment.reviewed)" />
              </div>
            </div>
            <div class="mt-3">
              <RecognitionEditor :original="segment.recognition" :manual="segment.manualRecognition" :read-only="!canEdit" :disabled="savingSegments.has(segment.id) || deletingSegmentId !== null" :save="value => saveRecognition(segment, value)" @editing="onTextEditing" />
            </div>
            <div class="mt-4 flex gap-4 text-sm">
              <div class="min-w-0 flex-1 text-left">
                <span class="mr-2 text-xs text-slate-500">被叫</span><input v-if="isEditingCallsign(segment, 'callee')" :value="segment.calleeCallsign ?? ''" lang="en" autocapitalize="characters" autocomplete="off" autocorrect="off" class="h-[30px] w-28 rounded-md border border-slate-700 bg-slate-950 px-2.5 py-0 font-mono uppercase outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/20" inputmode="text" :pattern="CALLSIGN_PATTERN.source" :title="CALLSIGN_HINT" aria-label="编辑被叫呼号" spellcheck="false" @blur="cancelCallsignEdit(segment, 'callee', $event.currentTarget as HTMLInputElement)" @input="normalizeCallsignInput" @keydown="onCallsignKeydown($event, segment, 'callee')"><button v-else type="button" class="inline-flex h-[30px] cursor-text items-center font-mono enabled:hover:underline focus:outline-none focus:underline disabled:cursor-default" :class="segment.calleeCallsign !== null ? 'text-emerald-400' : 'text-slate-100'" :disabled="!canEdit || savingSegments.has(segment.id) || deletingSegmentId !== null" aria-label="编辑被叫呼号" @click="beginCallsignEdit($event, segment, 'callee')">
                  {{ segment.calleeCallsign ?? '—' }}
                </button>
              </div>
              <div class="min-w-0 flex-1 text-left">
                <span class="mr-2 text-xs text-slate-500">主叫</span><input v-if="isEditingCallsign(segment, 'caller')" :value="segment.effectiveCallsign ?? ''" lang="en" autocapitalize="characters" autocomplete="off" autocorrect="off" class="h-[30px] w-28 rounded-md border border-slate-700 bg-slate-950 px-2.5 py-0 font-mono uppercase outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/20" inputmode="text" :pattern="CALLSIGN_PATTERN.source" :title="CALLSIGN_HINT" aria-label="编辑主叫呼号" spellcheck="false" @blur="cancelCallsignEdit(segment, 'caller', $event.currentTarget as HTMLInputElement)" @input="normalizeCallsignInput" @keydown="onCallsignKeydown($event, segment, 'caller')"><button v-else type="button" class="inline-flex h-[30px] cursor-text items-center font-mono enabled:hover:underline focus:outline-none focus:underline disabled:cursor-default" :class="segment.manualCallsign !== null ? 'text-emerald-400' : 'text-slate-100'" :disabled="!canEdit || savingSegments.has(segment.id) || deletingSegmentId !== null" aria-label="编辑主叫呼号" @click="beginCallsignEdit($event, segment, 'caller')">
                  <CallsignText :original="segment.callsign" :manual="segment.manualCallsign" />
                </button>
              </div>
            </div>
          </article>
        </div>
        <div class="hidden rounded-xl border border-slate-800 bg-slate-900/70 shadow-xl shadow-black/20 md:block">
          <table class="w-full table-fixed divide-y divide-slate-800 text-left text-sm leading-6" :class="isAdministrator ? 'min-w-[55rem]' : 'min-w-[49rem]'">
            <colgroup><col class="w-44"><col class="w-16"><col><col class="hidden w-32 min-[1200px]:table-column"><col class="w-32"><col class="w-24"><col v-if="isAdministrator" class="w-24"></colgroup><thead class="sticky top-32 z-10 bg-slate-900 text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th class="whitespace-nowrap px-4 py-3">
                  时间
                </th><th class="whitespace-nowrap px-4 py-3">
                  时长
                </th><th class="px-4 py-3">
                  识别文本
                </th><th class="hidden whitespace-nowrap px-4 py-3 min-[1200px]:table-cell">
                  被叫
                </th><th class="whitespace-nowrap px-4 py-3">
                  主叫
                </th><th class="whitespace-nowrap px-4 py-3">
                  播放
                </th><th v-if="isAdministrator" class="whitespace-nowrap px-4 py-3">
                  操作
                </th>
              </tr>
            </thead><tbody class="divide-y divide-slate-800/80">
              <tr v-for="segment in segments" :key="segment.id" class="align-top transition" :class="segment.reviewed ? 'bg-emerald-950/40 hover:bg-emerald-900/30' : 'hover:bg-slate-800/40'">
                <td class="whitespace-nowrap px-4 py-4 text-slate-400">
                  {{ formatTime(segment.capturedAt) }}
                </td><td class="whitespace-nowrap px-4 py-4">
                  {{ (segment.durationMs / 1_000).toFixed(1) }}s
                </td><td class="px-4 py-4">
                  <RecognitionEditor :original="segment.recognition" :manual="segment.manualRecognition" :read-only="!canEdit" :disabled="savingSegments.has(segment.id) || deletingSegmentId !== null" :save="value => saveRecognition(segment, value)" @editing="onTextEditing" />
                </td><td class="hidden px-4 py-3 min-[1200px]:table-cell">
                  <input v-if="isEditingCallsign(segment, 'callee')" :value="segment.calleeCallsign ?? ''" lang="en" autocapitalize="characters" autocomplete="off" autocorrect="off" class="h-8 w-28 rounded-md border border-slate-700 bg-slate-950 px-2.5 py-0 font-mono uppercase outline-none focus:border-cyan-500" inputmode="text" :pattern="CALLSIGN_PATTERN.source" :title="CALLSIGN_HINT" aria-label="编辑被叫呼号" spellcheck="false" @blur="cancelCallsignEdit(segment, 'callee', $event.currentTarget as HTMLInputElement)" @input="normalizeCallsignInput" @keydown="onCallsignKeydown($event, segment, 'callee')"><button v-else type="button" class="inline-flex h-8 cursor-text items-center font-mono enabled:hover:underline focus:outline-none focus:underline disabled:cursor-default" :class="segment.calleeCallsign !== null ? 'text-emerald-400' : 'text-slate-100'" :disabled="!canEdit || savingSegments.has(segment.id) || deletingSegmentId !== null" aria-label="编辑被叫呼号" @click="beginCallsignEdit($event, segment, 'callee')">
                    {{ segment.calleeCallsign ?? '—' }}
                  </button>
                </td><td class="px-4 py-3">
                  <input v-if="isEditingCallsign(segment, 'caller')" :value="segment.effectiveCallsign ?? ''" lang="en" autocapitalize="characters" autocomplete="off" autocorrect="off" class="h-8 w-28 rounded-md border border-slate-700 bg-slate-950 px-2.5 py-0 font-mono uppercase outline-none focus:border-cyan-500" inputmode="text" :pattern="CALLSIGN_PATTERN.source" :title="CALLSIGN_HINT" aria-label="编辑主叫呼号" spellcheck="false" @blur="cancelCallsignEdit(segment, 'caller', $event.currentTarget as HTMLInputElement)" @input="normalizeCallsignInput" @keydown="onCallsignKeydown($event, segment, 'caller')"><button v-else type="button" class="inline-flex h-8 cursor-text items-center font-mono enabled:hover:underline focus:outline-none focus:underline disabled:cursor-default" :class="segment.manualCallsign !== null ? 'text-emerald-400' : 'text-slate-100'" :disabled="!canEdit || savingSegments.has(segment.id) || deletingSegmentId !== null" aria-label="编辑主叫呼号" @click="beginCallsignEdit($event, segment, 'caller')">
                    <CallsignText :original="segment.callsign" :manual="segment.manualCallsign" />
                  </button>
                </td><td class="px-4 py-3">
                  <button v-if="canPlay(segment.capturedAt)" class="inline-flex h-8 items-center rounded-md border border-slate-700 px-3 py-1.5 text-xs transition hover:bg-slate-700" @click="togglePlayback(segment.id)">
                    {{ playingSegmentId === segment.id ? '停止' : '播放' }}
                  </button><span v-else class="text-xs text-slate-600">已过期</span>
                </td><td v-if="isAdministrator" class="px-3 py-3">
                  <div class="flex items-center gap-1">
                    <ReviewStar :reviewed="segment.reviewed" :disabled="savingSegments.has(segment.id) || deletingSegmentId !== null || textEditors > 0 || editingCallsign !== null" @toggle="setReviewed(segment, !segment.reviewed)" />
                    <button type="button" aria-label="删除记录" title="删除记录和录音" :disabled="isLoading || savingSegments.size > 0 || textEditors > 0 || editingCallsign !== null" class="inline-flex size-8 items-center justify-center rounded-md text-red-400 transition hover:bg-red-500/10 hover:text-red-300 focus:outline-none focus:ring-2 focus:ring-red-500/50 disabled:cursor-not-allowed disabled:opacity-40" @click="requestDeletion(segment, $event)">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="size-4" aria-hidden="true"><path d="M3 6h18M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M5 6l1 14a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1l1-14M10 10v7M14 10v7" /></svg>
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <nav class="sticky bottom-0 z-10 -mx-4 mt-3 flex shrink-0 flex-wrap items-center justify-center gap-2 border-t border-slate-800 bg-slate-950/95 px-3 py-2 text-xs backdrop-blur sm:-mx-6 sm:gap-3 sm:px-6 sm:py-3 sm:text-sm lg:-mx-8 lg:px-8">
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
    </main>
    <dialog ref="deleteDialog" aria-labelledby="delete-dialog-title" aria-describedby="delete-dialog-description" class="m-auto w-[calc(100%_-_2rem)] max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-6 text-slate-100 shadow-2xl backdrop:bg-slate-950/75 backdrop:backdrop-blur-sm" @cancel="onDeleteDialogCancel" @close="onDeleteDialogClose">
      <form v-if="pendingDeletion" @submit.prevent="deleteSegment">
        <h2 id="delete-dialog-title" class="text-lg font-semibold">
          删除这条记录？
        </h2>
        <p id="delete-dialog-description" class="mt-2 text-sm leading-6 text-slate-300">
          数据库记录和对应录音将被永久删除，无法恢复。
        </p>
        <div class="mt-4 rounded-lg border border-slate-700 bg-slate-950/60 p-3">
          <p class="text-xs text-slate-400">
            {{ formatTime(pendingDeletion.capturedAt) }}
            <span class="ml-2 font-mono">{{ pendingDeletion.effectiveCallsign ?? '无主叫呼号' }}</span>
          </p>
          <p class="mt-2 line-clamp-4 whitespace-pre-wrap break-words text-sm leading-6 text-slate-200">
            {{ pendingDeletion.manualRecognition ?? pendingDeletion.recognition }}
          </p>
        </div>
        <p v-if="deleteError" role="alert" class="mt-3 text-sm text-red-400">
          {{ deleteError }}
        </p>
        <div class="mt-6 flex justify-end gap-3">
          <button type="button" autofocus :disabled="deletingSegmentId !== null" class="rounded-lg border border-slate-600 px-4 py-2 text-sm transition hover:bg-slate-800 focus:outline-none disabled:cursor-wait disabled:opacity-50" @click="closeDeleteDialog">
            取消
          </button>
          <button type="submit" :disabled="deletingSegmentId !== null" class="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-500 focus:outline-none disabled:cursor-wait disabled:opacity-50">
            {{ deletingSegmentId !== null ? '删除中…' : '确认删除' }}
          </button>
        </div>
      </form>
    </dialog>
  </div>
</template>
