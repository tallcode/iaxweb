import type { AdminRecord, PersistedRecord } from '@iaxweb/contracts'
import type { RecordsQuery } from '../../api/records'
import type { RecordsFeedback, RecordsQueryController } from './types'
import { RECORD_CALLSIGN_FILTER_PATTERN } from '@iaxweb/contracts'
import { computed, nextTick, onBeforeUnmount, onMounted, readonly, ref, shallowRef } from 'vue'
import { ApiError, apiErrorMessage } from '../../api/client'
import { recordsApi } from '../../api/records'
import { RECORD_CALLSIGN_FILTER_HINT } from '../../utils/callsign'
import { useConditionalAutoRefresh } from '../use-conditional-auto-refresh'

const PAGE_SIZE = 50
type QueryCriteria = Required<Omit<RecordsQuery, 'pageSize' | 'recordId'>>

interface QueryOptions {
  canChange: () => boolean
  canAutoRefresh: () => boolean
  onUnauthorized: () => Promise<void>
  onNavigate: () => void
  feedback: RecordsFeedback
}

export function useRecordsQuery(options: QueryOptions): RecordsQueryController {
  const records = ref<AdminRecord[]>([])
  const total = ref(0)
  const currentPage = ref(1)
  const pageInput = ref('1')
  const searchInput = ref('')
  const callsignFilter = ref('')
  const editedOnly = ref(false)
  const reviewedOnly = ref(false)
  const highlightedRecordId = ref<string | null>(null)
  const isLoading = ref(false)
  const appliedQuery = shallowRef<QueryCriteria>({ page: 1, callsign: '', editedOnly: false, reviewedOnly: false })
  let request: { controller: AbortController, restore: () => void } | undefined
  const pageCount = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))
  const filtered = computed(() => !!appliedQuery.value.callsign || appliedQuery.value.editedOnly || appliedQuery.value.reviewedOnly)
  const summary = computed(() => `共 ${total.value} 条${filtered.value ? '匹配' : ''}记录`)
  const { markRefreshed } = useConditionalAutoRefresh({
    canRefresh: () => options.canAutoRefresh() && currentPage.value === 1 && !isLoading.value
      && searchInput.value === '' && !filtered.value && highlightedRecordId.value === null,
    refresh: reload,
  })
  onMounted(() => void reload())
  onBeforeUnmount(abort)

  function abort(): void {
    if (!request)
      return
    request.controller.abort()
    request.restore()
    request = undefined
    isLoading.value = false
  }

  async function reload(navigate = false): Promise<void> {
    // Consecutive page or filter changes use the controls' latest pending values.
    request?.controller.abort()
    const controller = new AbortController()
    const draft = searchInput.value
    const contextId = !navigate && !filtered.value ? highlightedRecordId.value : null
    const query: QueryCriteria = {
      page: currentPage.value,
      callsign: callsignFilter.value,
      editedOnly: editedOnly.value,
      reviewedOnly: reviewedOnly.value,
    }
    const active = {
      controller,
      restore() {
        const applied = appliedQuery.value
        if (query.callsign !== applied.callsign && searchInput.value === draft)
          searchInput.value = applied.callsign
        currentPage.value = applied.page
        pageInput.value = String(applied.page)
        callsignFilter.value = applied.callsign
        editedOnly.value = applied.editedOnly
        reviewedOnly.value = applied.reviewedOnly
      },
    }
    request = active
    isLoading.value = true
    try {
      while (true) {
        const data = await recordsApi.list({ ...query, pageSize: PAGE_SIZE, ...(contextId ? { recordId: contextId } : {}) }, controller.signal)
        if (controller.signal.aborted)
          return
        if (contextId)
          query.page = data.page
        const lastPage = Math.max(1, Math.ceil(data.total / PAGE_SIZE))
        if (query.page > lastPage) {
          query.page = lastPage
          continue
        }
        appliedQuery.value = query
        currentPage.value = query.page
        pageInput.value = String(query.page)
        total.value = data.total
        records.value = data.items
        if (navigate || !data.items.some(record => record.id === highlightedRecordId.value))
          highlightedRecordId.value = null
        markRefreshed()
        options.feedback.showSummary()
        if (navigate)
          options.onNavigate()
        break
      }
    }
    catch (error) {
      if (controller.signal.aborted)
        return
      active.restore()
      if (error instanceof ApiError && error.status === 401)
        await options.onUnauthorized()
      else
        options.feedback.showError(apiErrorMessage(error, '加载失败'))
    }
    finally {
      if (request === active) {
        isLoading.value = false
        request = undefined
      }
    }
  }

  async function changePage(page: number): Promise<void> {
    if (!options.canChange())
      return
    currentPage.value = Math.min(Math.max(page, 1), pageCount.value)
    pageInput.value = String(currentPage.value)
    await reload(true)
  }

  async function goToPage(): Promise<void> {
    if (!options.canChange())
      return
    const page = Number(pageInput.value)
    if (!Number.isInteger(page) || page === currentPage.value) {
      pageInput.value = String(currentPage.value)
      return
    }
    await changePage(page)
  }

  async function searchCallsign(): Promise<void> {
    if (!options.canChange())
      return
    const callsign = searchInput.value.trim().toUpperCase()
    searchInput.value = callsign
    if (callsign && !RECORD_CALLSIGN_FILTER_PATTERN.test(callsign)) {
      options.feedback.showError(`搜索失败：${RECORD_CALLSIGN_FILTER_HINT}`)
      return
    }
    callsignFilter.value = callsign
    await applyFilters()
  }

  async function applyFilters(): Promise<void> {
    if (!options.canChange())
      return
    currentPage.value = 1
    pageInput.value = '1'
    await reload(true)
  }

  async function clearCallsignSearch(): Promise<void> {
    if (!options.canChange())
      return
    searchInput.value = ''
    callsignFilter.value = ''
    editedOnly.value = false
    reviewedOnly.value = false
    await applyFilters()
  }

  async function showContext(id: string): Promise<void> {
    if (!options.canChange())
      return
    request?.controller.abort()
    const controller = new AbortController()
    // Context navigation does not change controls or rows until it succeeds.
    const active = { controller, restore() {} }
    request = active
    isLoading.value = true
    try {
      const data = await recordsApi.list({ recordId: id, page: 1, pageSize: PAGE_SIZE }, controller.signal)
      if (controller.signal.aborted)
        return
      if (!data.items.some(record => record.id === id))
        throw new ApiError('protocol', '目标记录不在返回的页面中')
      appliedQuery.value = { page: data.page, callsign: '', editedOnly: false, reviewedOnly: false }
      currentPage.value = data.page
      pageInput.value = String(data.page)
      searchInput.value = ''
      callsignFilter.value = ''
      editedOnly.value = false
      reviewedOnly.value = false
      total.value = data.total
      records.value = data.items
      highlightedRecordId.value = id
      markRefreshed()
      options.feedback.showSummary()
      await nextTick()
      if (controller.signal.aborted)
        return
      // Card and table layouts coexist. Scroll only the currently visible row.
      const row = [...document.querySelectorAll<HTMLElement>('[data-record-id]')]
        .find(element => element.dataset.recordId === id && element.getClientRects().length > 0)
      const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false
      row?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center', inline: 'nearest' })
    }
    catch (error) {
      if (controller.signal.aborted)
        return
      if (error instanceof ApiError && error.status === 401)
        await options.onUnauthorized()
      else if (error instanceof ApiError && error.status === 404)
        options.feedback.showError('记录已不存在，请刷新列表')
      else
        options.feedback.showError(apiErrorMessage(error, '定位失败，请重试'))
    }
    finally {
      if (request === active) {
        isLoading.value = false
        request = undefined
      }
    }
  }

  async function updateRecord(updated: PersistedRecord): Promise<void> {
    abort()
    const edited = updated.manualRecognition !== null || updated.manualCallsign !== null || updated.calleeCallsign !== null
    const applied = appliedQuery.value
    const matchesCallsign = !applied.callsign || updated.effectiveCallsign?.toUpperCase().endsWith(applied.callsign)
    const matches = matchesCallsign && (!applied.editedOnly || edited) && (!applied.reviewedOnly || updated.reviewed)
    if (matches) {
      records.value = records.value.map(row => row.id === updated.id ? { ...row, ...updated } : row)
    }
    else {
      removeRecord(updated.id)
      await reload()
    }
  }

  function removeRecord(id: string): void {
    if (highlightedRecordId.value === id)
      highlightedRecordId.value = null
    records.value = records.value.filter(row => row.id !== id)
    total.value = Math.max(0, total.value - 1)
  }
  function clear(): void {
    abort()
    records.value = []
    total.value = 0
    highlightedRecordId.value = null
  }
  function setSearchInput(value: string): void {
    if (options.canChange())
      searchInput.value = value
  }
  function setPageInput(value: string): void {
    if (options.canChange())
      pageInput.value = value
  }
  function setEditedOnly(value: boolean): void {
    if (options.canChange())
      editedOnly.value = value
  }
  function setReviewedOnly(value: boolean): void {
    if (options.canChange())
      reviewedOnly.value = value
  }

  return {
    state: {
      records: readonly(records),
      total: readonly(total),
      currentPage: readonly(currentPage),
      pageInput: readonly(pageInput),
      pageCount,
      searchInput: readonly(searchInput),
      callsignFilter: readonly(callsignFilter),
      editedOnly: readonly(editedOnly),
      reviewedOnly: readonly(reviewedOnly),
      isFiltered: filtered,
      highlightedRecordId: readonly(highlightedRecordId),
      isLoading: readonly(isLoading),
      disabled: computed(() => !options.canChange()),
    },
    actions: { setSearchInput, setPageInput, setEditedOnly, setReviewedOnly, searchCallsign, applyFilters, clearCallsignSearch, showContext, changePage, goToPage },
    summary,
    reload,
    abort,
    updateRecord,
    removeRecord,
    clear,
  }
}
