<script setup lang="ts">
import type { AdminRecord, AdminRecordPage, PersistedRecord } from '@iaxweb/contracts'
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { adminSession } from '../admin-session'
import AdminPageHeader from '../components/AdminPageHeader.vue'
import CallsignText from '../components/CallsignText.vue'
import RecognitionEditor from '../components/RecognitionEditor.vue'
import ReviewStar from '../components/ReviewStar.vue'
import { useConditionalAutoRefresh } from '../composables/use-conditional-auto-refresh'

const PAGE_SIZE = 50
const CALLSIGN_PATTERN = /^(?:B[ADGHIY]\d[A-Z]{2,3}|N0CALL)$/
const CALLSIGN_HINT = '请输入 N0CALL，或 BA/BD/BG/BH/BI/BY + 数字 + 2–3 个字母'
const router = useRouter()
const statusMessage = ref('共 0 条记录')
const records = ref<AdminRecord[]>([])
const userRole = computed(() => adminSession.value?.role ?? 'viewer')
const username = computed(() => adminSession.value?.username ?? '')
const loggingOut = ref(false)
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
const savingRecords = ref(new Set<string>())
const deletingRecordId = ref<string | null>(null)
const pendingDeletion = ref<PersistedRecord | null>(null)
const deleteDialog = ref<HTMLDialogElement>()
const deleteError = ref('')
const searchField = ref<HTMLInputElement>()
const playingRecordId = ref<string | null>(null)
const isLoading = ref(false)
const audioPlayer = new Audio()
let recordRequest: AbortController | undefined
let deleteTrigger: HTMLButtonElement | undefined

const pageCount = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))
const isRecordSummary = computed(() => /^共 \d+ 条(?:匹配)?记录$/.test(statusMessage.value))
const compactStatus = computed(() => {
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
    && savingRecords.value.size === 0
    && pendingDeletion.value === null
    && searchInput.value === ''
    && callsignFilter.value === ''
    && !editedOnly.value
    && !reviewedOnly.value
    && !isLoading.value,
  refresh: loadRecords,
})

audioPlayer.addEventListener('ended', stopPlayback)
audioPlayer.addEventListener('error', handlePlaybackError)
onMounted(() => void loadRecords())
onBeforeUnmount(() => {
  recordRequest?.abort()
  stopPlayback()
  audioPlayer.removeEventListener('ended', stopPlayback)
  audioPlayer.removeEventListener('error', handlePlaybackError)
})

async function loadRecords(): Promise<void> {
  recordRequest?.abort()
  const request = new AbortController()
  recordRequest = request
  isLoading.value = true
  try {
    const query = new URLSearchParams({ page: String(currentPage.value), pageSize: String(PAGE_SIZE) })
    if (callsignFilter.value)
      query.set('callsign', callsignFilter.value)
    if (editedOnly.value)
      query.set('editedOnly', 'true')
    if (reviewedOnly.value)
      query.set('reviewedOnly', 'true')
    const response = await fetch(`/api/admin/records?${query}`, { signal: request.signal })
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
    const data = await response.json() as AdminRecordPage
    if (request.signal.aborted)
      return
    total.value = data.total
    const lastPage = Math.max(1, Math.ceil(data.total / PAGE_SIZE))
    if (currentPage.value > lastPage) {
      currentPage.value = lastPage
      pageInput.value = String(lastPage)
      await loadRecords()
      return
    }
    records.value = data.items
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
    if (recordRequest === request) {
      isLoading.value = false
      recordRequest = undefined
    }
  }
}

function scrollToPageTop(): void {
  window.scrollTo({ behavior: 'smooth', top: 0 })
}

async function logout(): Promise<void> {
  if (loggingOut.value || savingRecords.value.size > 0)
    return
  loggingOut.value = true
  recordRequest?.abort()
  stopPlayback()
  try {
    const response = await fetch('/api/admin/logout', { method: 'POST' })
    if (!response.ok && response.status !== 401) {
      statusMessage.value = '注销失败，请重试'
      return
    }
    adminSession.value = null
    records.value = []
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
  await loadRecords()
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
  await loadRecords()
  scrollToPageTop()
}

async function applyFilters(): Promise<void> {
  currentPage.value = 1
  pageInput.value = '1'
  await loadRecords()
  scrollToPageTop()
}

function canEditRecord(record: PersistedRecord): boolean {
  return isAdministrator.value || (userRole.value === 'editor' && !record.reviewed)
}

function matchesFilters(record: PersistedRecord): boolean {
  const edited = record.manualRecognition !== null || record.manualCallsign !== null || record.calleeCallsign !== null
  return (!callsignFilter.value || record.effectiveCallsign === callsignFilter.value)
    && (!editedOnly.value || edited)
    && (!reviewedOnly.value || record.reviewed)
}

async function clearCallsignSearch(): Promise<void> {
  searchInput.value = ''
  callsignFilter.value = ''
  editedOnly.value = false
  reviewedOnly.value = false
  currentPage.value = 1
  pageInput.value = '1'
  await loadRecords()
  scrollToPageTop()
}

async function togglePlayback(id: string): Promise<void> {
  if (playingRecordId.value === id) {
    stopPlayback()
    return
  }
  stopPlayback()
  playingRecordId.value = id
  audioPlayer.src = `/api/admin/records/${encodeURIComponent(id)}/audio`
  try {
    await audioPlayer.play()
  }
  catch {
    handlePlaybackError()
  }
}

async function requestDeletion(record: PersistedRecord, event: MouseEvent): Promise<void> {
  if (!isAdministrator.value || pendingDeletion.value || savingRecords.value.size > 0 || textEditors.value > 0 || editingCallsign.value !== null)
    return
  recordRequest?.abort()
  deleteTrigger = event.currentTarget as HTMLButtonElement
  pendingDeletion.value = record
  deleteError.value = ''
  await nextTick()
  if (deleteDialog.value) {
    deleteDialog.value.returnValue = ''
    deleteDialog.value.showModal()
  }
}

function closeDeleteDialog(): void {
  if (deletingRecordId.value === null)
    deleteDialog.value?.close()
}

function onDeleteDialogCancel(event: Event): void {
  if (deletingRecordId.value !== null)
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

async function deleteRecord(): Promise<void> {
  const record = pendingDeletion.value
  if (!record || !isAdministrator.value || deletingRecordId.value !== null)
    return
  deleteError.value = ''
  savingRecords.value.add(record.id)
  deletingRecordId.value = record.id
  recordRequest?.abort()
  try {
    const response = await fetch(`/api/admin/records/${encodeURIComponent(record.id)}`, { method: 'DELETE' })
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
    if (playingRecordId.value === record.id)
      stopPlayback()
    records.value = records.value.filter(row => row.id !== record.id)
    total.value = Math.max(0, total.value - 1)
    await loadRecords()
    deleteDialog.value?.close('deleted')
  }
  catch {
    deleteError.value = '删除失败：无法连接服务器'
    statusMessage.value = deleteError.value
  }
  finally {
    savingRecords.value.delete(record.id)
    deletingRecordId.value = null
  }
}

function stopPlayback(): void {
  audioPlayer.pause()
  audioPlayer.removeAttribute('src')
  audioPlayer.load()
  playingRecordId.value = null
}

function handlePlaybackError(): void {
  stopPlayback()
  statusMessage.value = '播放失败：录音可能已被清理'
}

function callsignFor(record: PersistedRecord, role: CallsignRole): string | null {
  return role === 'callee' ? record.calleeCallsign : record.effectiveCallsign
}

function isEditingCallsign(record: PersistedRecord, role: CallsignRole): boolean {
  return editingCallsign.value?.id === record.id && editingCallsign.value.role === role
}

function onTextEditing(editing: boolean): void {
  textEditors.value += editing ? 1 : -1
  if (editing)
    recordRequest?.abort()
}

async function patchRecord(record: PersistedRecord, endpoint: string, body: unknown): Promise<PersistedRecord | undefined> {
  if (!canEditRecord(record) || savingRecords.value.has(record.id) || deletingRecordId.value !== null)
    return undefined
  savingRecords.value.add(record.id)
  recordRequest?.abort()
  try {
    const response = await fetch(`/api/admin/records/${encodeURIComponent(record.id)}/${endpoint}`, {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      method: 'PATCH',
    })
    if (response.status === 401) {
      await router.replace('/')
      return undefined
    }
    if (response.status === 403) {
      let message = '没有编辑权限，请刷新后重试'
      try {
        const error = await response.json() as { message?: unknown }
        if (typeof error.message === 'string')
          message = error.message
      }
      catch {}
      editingCallsign.value = null
      await loadRecords()
      statusMessage.value = message
      return undefined
    }
    if (!response.ok) {
      statusMessage.value = response.status === 404 ? '保存失败：记录不存在' : '保存失败，请检查输入后重试'
      return undefined
    }
    const updated = await response.json() as PersistedRecord
    recordRequest?.abort()
    Object.assign(record, updated)
    const visible = records.value.find(row => row.id === record.id)
    if (visible && visible !== record)
      Object.assign(visible, updated)
    statusMessage.value = callsignFilter.value || editedOnly.value || reviewedOnly.value
      ? `共 ${total.value} 条匹配记录`
      : `共 ${total.value} 条记录`
    if (!matchesFilters(updated))
      await loadRecords()
    return updated
  }
  catch {
    statusMessage.value = '保存失败：无法连接服务器'
    return undefined
  }
  finally {
    savingRecords.value.delete(record.id)
  }
}

async function saveRecognition(record: PersistedRecord, recognition: string | null): Promise<boolean> {
  return !!await patchRecord(record, 'manual-recognition', { recognition })
}

async function setReviewed(record: PersistedRecord, reviewed: boolean): Promise<void> {
  if (!isAdministrator.value)
    return
  await patchRecord(record, 'manual-review', { reviewed })
}

async function saveCallsign(record: PersistedRecord, role: CallsignRole, input: HTMLInputElement): Promise<boolean> {
  const callsign = input.value.trim().toUpperCase()
  if (callsign && !CALLSIGN_PATTERN.test(callsign)) {
    input.setCustomValidity(CALLSIGN_HINT)
    input.reportValidity()
    statusMessage.value = `保存失败：${CALLSIGN_HINT}`
    return false
  }
  input.setCustomValidity('')
  const endpoint = role === 'callee' ? 'manual-callee-callsign' : 'manual-callsign'
  const updatedRecord = await patchRecord(record, endpoint, { callsign: callsign || null })
  if (!updatedRecord)
    return false
  return true
}

function beginCallsignEdit(event: MouseEvent, record: PersistedRecord, role: CallsignRole): void {
  if (!canEditRecord(record) || savingRecords.value.has(record.id) || deletingRecordId.value !== null)
    return
  recordRequest?.abort()
  const container = (event.currentTarget as HTMLElement).parentElement
  editingCallsign.value = { id: record.id, role }
  void nextTick(() => {
    const input = container?.querySelector<HTMLInputElement>('input')
    input?.focus()
    input?.select()
  })
}

function cancelCallsignEdit(record: PersistedRecord, role: CallsignRole, input: HTMLInputElement): void {
  input.value = callsignFor(record, role) ?? ''
  if (isEditingCallsign(record, role))
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

async function onCallsignKeydown(event: KeyboardEvent, record: PersistedRecord, role: CallsignRole): Promise<void> {
  const input = event.currentTarget as HTMLInputElement
  if (event.key === 'Escape') {
    event.preventDefault()
    cancelCallsignEdit(record, role, input)
    return
  }
  if (event.key !== 'Enter')
    return
  event.preventDefault()
  if (await saveCallsign(record, role, input))
    editingCallsign.value = null
}

function formatTime(iso: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'Asia/Shanghai' }).format(new Date(iso))
}
</script>

<template>
  <div class="min-h-dvh min-w-[380px] bg-slate-950 text-slate-100">
    <AdminPageHeader title="记录管理" :username="username" :logging-out="loggingOut" :disabled="savingRecords.size > 0" @logout="logout">
      <RouterLink v-if="isAdministrator" to="/users" class="shrink-0 text-xs text-slate-400 transition hover:text-slate-100 sm:text-sm">
        用户管理
      </RouterLink>
    </AdminPageHeader>
    <main :inert="loggingOut" class="mx-auto flex min-h-dvh w-full max-w-screen-2xl flex-col px-4 pt-32 sm:px-6 lg:px-8">
      <div class="fixed inset-x-0 top-16 z-20 h-16 min-w-[380px] bg-slate-950" aria-label="筛选工具栏">
        <div class="mx-auto flex h-full max-w-screen-2xl flex-nowrap items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8">
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
              <button v-if="searchInput || callsignFilter || editedOnly || reviewedOnly" type="button" aria-label="清除" title="清除搜索和筛选" class="hidden shrink-0 items-center justify-center rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 transition hover:border-slate-500 hover:bg-slate-800 focus:outline-none sm:inline-flex" @click="clearCallsignSearch">
                清除
              </button>
              <button type="submit" aria-label="搜索" title="搜索" class="inline-flex size-10 shrink-0 items-center justify-center rounded-lg border border-slate-700 text-sm text-slate-300 transition hover:border-slate-500 hover:bg-slate-800 focus:outline-none sm:h-auto sm:w-auto sm:px-4 sm:py-2">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="size-4 sm:hidden" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>
                <span class="hidden sm:inline">搜索</span>
              </button>
            </div>
          </form>
          <p v-if="statusMessage && !isRecordSummary && !isLoading" role="status" class="w-full break-words text-xs text-amber-300 sm:hidden">
            {{ statusMessage }}
          </p>
        </div>
      </div>
      <div role="region" aria-label="识别记录" class="flex-1">
        <div class="space-y-3 lg:hidden">
          <article v-for="record in records" :key="record.id" class="rounded-xl border p-4 shadow-xl shadow-black/20" :class="record.reviewed ? 'border-emerald-800/60 bg-emerald-950/40' : 'border-slate-800 bg-slate-900/70'">
            <div class="flex items-center justify-between gap-3">
              <div class="min-w-0">
                <p class="text-sm font-medium text-slate-200">
                  {{ formatTime(record.capturedAt) }}<span class="ml-3 text-xs font-normal text-slate-500">{{ (record.durationMs / 1_000).toFixed(1) }}s</span>
                </p>
              </div><div class="flex shrink-0 items-center gap-3">
                <button v-if="record.hasAudio" class="shrink-0 rounded-md border border-slate-700 px-3 py-1.5 text-xs transition hover:bg-slate-700" @click="togglePlayback(record.id)">
                  {{ playingRecordId === record.id ? '停止' : '播放' }}
                </button><span v-else class="shrink-0 text-xs text-slate-600">已过期</span>
                <ReviewStar v-if="isAdministrator" :reviewed="record.reviewed" :disabled="savingRecords.has(record.id) || deletingRecordId !== null || textEditors > 0 || editingCallsign !== null" @toggle="setReviewed(record, !record.reviewed)" />
              </div>
            </div>
            <div class="mt-3">
              <RecognitionEditor :original="record.recognition" :manual="record.manualRecognition" :read-only="!canEditRecord(record)" :disabled="savingRecords.has(record.id) || deletingRecordId !== null" :save="value => saveRecognition(record, value)" @editing="onTextEditing" />
            </div>
            <div class="mt-4 flex gap-4 text-sm">
              <div class="flex min-w-0 flex-1 items-center gap-2 text-left">
                <span class="shrink-0 text-xs text-slate-500">被叫</span><input v-if="isEditingCallsign(record, 'callee')" :value="record.calleeCallsign ?? ''" lang="en" autocapitalize="characters" autocomplete="off" autocorrect="off" class="h-[30px] w-28 rounded-md border border-slate-700 bg-slate-950 px-2.5 py-0 font-mono uppercase outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/20" inputmode="text" :pattern="CALLSIGN_PATTERN.source" :title="CALLSIGN_HINT" aria-label="编辑被叫呼号" spellcheck="false" @blur="cancelCallsignEdit(record, 'callee', $event.currentTarget as HTMLInputElement)" @input="normalizeCallsignInput" @keydown="onCallsignKeydown($event, record, 'callee')"><button v-else type="button" class="inline-flex h-[30px] cursor-text items-center font-mono enabled:hover:underline focus:outline-none focus:underline disabled:cursor-default" :class="record.calleeCallsign !== null ? 'text-emerald-400' : 'text-slate-100'" :disabled="!canEditRecord(record) || savingRecords.has(record.id) || deletingRecordId !== null" aria-label="编辑被叫呼号" @click="beginCallsignEdit($event, record, 'callee')">
                  {{ record.calleeCallsign ?? '—' }}
                </button>
              </div>
              <div class="flex min-w-0 flex-1 items-center gap-2 text-left">
                <span class="shrink-0 text-xs text-slate-500">主叫</span><input v-if="isEditingCallsign(record, 'caller')" :value="record.effectiveCallsign ?? ''" lang="en" autocapitalize="characters" autocomplete="off" autocorrect="off" class="h-[30px] w-28 rounded-md border border-slate-700 bg-slate-950 px-2.5 py-0 font-mono uppercase outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/20" inputmode="text" :pattern="CALLSIGN_PATTERN.source" :title="CALLSIGN_HINT" aria-label="编辑主叫呼号" spellcheck="false" @blur="cancelCallsignEdit(record, 'caller', $event.currentTarget as HTMLInputElement)" @input="normalizeCallsignInput" @keydown="onCallsignKeydown($event, record, 'caller')"><button v-else type="button" class="inline-flex h-[30px] cursor-text items-center font-mono enabled:hover:underline focus:outline-none focus:underline disabled:cursor-default" :class="record.manualCallsign !== null ? 'text-emerald-400' : 'text-slate-100'" :disabled="!canEditRecord(record) || savingRecords.has(record.id) || deletingRecordId !== null" aria-label="编辑主叫呼号" @click="beginCallsignEdit($event, record, 'caller')">
                  <CallsignText :original="record.callsign" :manual="record.manualCallsign" />
                </button>
              </div>
            </div>
          </article>
        </div>
        <div class="hidden overflow-clip rounded-xl border border-slate-800 bg-slate-900/70 shadow-xl shadow-black/20 lg:block">
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
              <tr v-for="record in records" :key="record.id" class="align-top transition" :class="record.reviewed ? 'bg-emerald-950/40 hover:bg-emerald-900/30' : 'hover:bg-slate-800/40'">
                <td class="whitespace-nowrap px-4 py-4 text-slate-400">
                  {{ formatTime(record.capturedAt) }}
                </td><td class="whitespace-nowrap px-4 py-4">
                  {{ (record.durationMs / 1_000).toFixed(1) }}s
                </td><td class="px-4 py-4">
                  <RecognitionEditor :original="record.recognition" :manual="record.manualRecognition" :read-only="!canEditRecord(record)" :disabled="savingRecords.has(record.id) || deletingRecordId !== null" :save="value => saveRecognition(record, value)" @editing="onTextEditing" />
                </td><td class="hidden px-4 py-3 min-[1200px]:table-cell">
                  <input v-if="isEditingCallsign(record, 'callee')" :value="record.calleeCallsign ?? ''" lang="en" autocapitalize="characters" autocomplete="off" autocorrect="off" class="h-8 w-28 rounded-md border border-slate-700 bg-slate-950 px-2.5 py-0 font-mono uppercase outline-none focus:border-cyan-500" inputmode="text" :pattern="CALLSIGN_PATTERN.source" :title="CALLSIGN_HINT" aria-label="编辑被叫呼号" spellcheck="false" @blur="cancelCallsignEdit(record, 'callee', $event.currentTarget as HTMLInputElement)" @input="normalizeCallsignInput" @keydown="onCallsignKeydown($event, record, 'callee')"><button v-else type="button" class="inline-flex h-8 cursor-text items-center font-mono enabled:hover:underline focus:outline-none focus:underline disabled:cursor-default" :class="record.calleeCallsign !== null ? 'text-emerald-400' : 'text-slate-100'" :disabled="!canEditRecord(record) || savingRecords.has(record.id) || deletingRecordId !== null" aria-label="编辑被叫呼号" @click="beginCallsignEdit($event, record, 'callee')">
                    {{ record.calleeCallsign ?? '—' }}
                  </button>
                </td><td class="px-4 py-3">
                  <input v-if="isEditingCallsign(record, 'caller')" :value="record.effectiveCallsign ?? ''" lang="en" autocapitalize="characters" autocomplete="off" autocorrect="off" class="h-8 w-28 rounded-md border border-slate-700 bg-slate-950 px-2.5 py-0 font-mono uppercase outline-none focus:border-cyan-500" inputmode="text" :pattern="CALLSIGN_PATTERN.source" :title="CALLSIGN_HINT" aria-label="编辑主叫呼号" spellcheck="false" @blur="cancelCallsignEdit(record, 'caller', $event.currentTarget as HTMLInputElement)" @input="normalizeCallsignInput" @keydown="onCallsignKeydown($event, record, 'caller')"><button v-else type="button" class="inline-flex h-8 cursor-text items-center font-mono enabled:hover:underline focus:outline-none focus:underline disabled:cursor-default" :class="record.manualCallsign !== null ? 'text-emerald-400' : 'text-slate-100'" :disabled="!canEditRecord(record) || savingRecords.has(record.id) || deletingRecordId !== null" aria-label="编辑主叫呼号" @click="beginCallsignEdit($event, record, 'caller')">
                    <CallsignText :original="record.callsign" :manual="record.manualCallsign" />
                  </button>
                </td><td class="px-4 py-3">
                  <button v-if="record.hasAudio" class="inline-flex h-8 items-center rounded-md border border-slate-700 px-3 py-1.5 text-xs transition hover:bg-slate-700" @click="togglePlayback(record.id)">
                    {{ playingRecordId === record.id ? '停止' : '播放' }}
                  </button><span v-else class="inline-flex h-8 items-center text-xs text-slate-600">已过期</span>
                </td><td v-if="isAdministrator" class="px-3 py-3">
                  <div class="flex items-center gap-1">
                    <ReviewStar :reviewed="record.reviewed" :disabled="savingRecords.has(record.id) || deletingRecordId !== null || textEditors > 0 || editingCallsign !== null" @toggle="setReviewed(record, !record.reviewed)" />
                    <button type="button" aria-label="删除记录" title="删除记录和录音" :disabled="isLoading || savingRecords.size > 0 || textEditors > 0 || editingCallsign !== null" class="inline-flex size-8 items-center justify-center rounded-md text-red-400 transition hover:bg-red-500/10 hover:text-red-300 focus:outline-none focus:ring-2 focus:ring-red-500/50 disabled:cursor-not-allowed disabled:opacity-40" @click="requestDeletion(record, $event)">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="size-4" aria-hidden="true"><path d="M3 6h18M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M5 6l1 14a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1l1-14M10 10v7M14 10v7" /></svg>
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <nav class="sticky bottom-0 z-10 -mx-4 mt-3 flex shrink-0 flex-wrap items-center justify-center gap-2 border-t border-slate-800 bg-slate-950 px-3 py-2 text-xs sm:-mx-6 sm:gap-3 sm:px-6 sm:py-3 sm:text-sm lg:-mx-8 lg:px-8">
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
      <form v-if="pendingDeletion" @submit.prevent="deleteRecord">
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
          <button type="button" autofocus :disabled="deletingRecordId !== null" class="rounded-lg border border-slate-600 px-4 py-2 text-sm transition hover:bg-slate-800 focus:outline-none disabled:cursor-wait disabled:opacity-50" @click="closeDeleteDialog">
            取消
          </button>
          <button type="submit" :disabled="deletingRecordId !== null" class="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-500 focus:outline-none disabled:cursor-wait disabled:opacity-50">
            {{ deletingRecordId !== null ? '删除中…' : '确认删除' }}
          </button>
        </div>
      </form>
    </dialog>
  </div>
</template>
