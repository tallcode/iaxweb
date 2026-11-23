import type { AdminRecord, PersistedRecord } from '@iaxweb/contracts'
import type { RecordsQuery } from '../../api/records'
import type { RecordsFeedback, RecordsQueryController } from './types'
import { CALLSIGN_HINT, MANUAL_CALLSIGN_PATTERN } from '@iaxweb/contracts'
import { computed, onBeforeUnmount, onMounted, readonly, ref, shallowRef } from 'vue'
import { ApiError, apiErrorMessage } from '../../api/client'
import { recordsApi } from '../../api/records'
import { useConditionalAutoRefresh } from '../use-conditional-auto-refresh'

const PAGE_SIZE = 50
type QueryCriteria = Required<Omit<RecordsQuery, 'pageSize'>>

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
  const isLoading = ref(false)
  const appliedQuery = shallowRef<QueryCriteria>({ page: 1, callsign: '', editedOnly: false, reviewedOnly: false })
  let request: { controller: AbortController, restore: () => void } | undefined
  const pageCount = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))
  const filtered = computed(() => !!appliedQuery.value.callsign || appliedQuery.value.editedOnly || appliedQuery.value.reviewedOnly)
  const summary = computed(() => `共 ${total.value} 条${filtered.value ? '匹配' : ''}记录`)
  const { markRefreshed } = useConditionalAutoRefresh({
    canRefresh: () => options.canAutoRefresh() && currentPage.value === 1 && !isLoading.value
      && searchInput.value === '' && !filtered.value,
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
        const data = await recordsApi.list({ ...query, pageSize: PAGE_SIZE }, controller.signal)
        if (controller.signal.aborted)
          return
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
    if (callsign && !MANUAL_CALLSIGN_PATTERN.test(callsign)) {
      options.feedback.showError(`搜索失败：${CALLSIGN_HINT}`)
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

  async function updateRecord(updated: PersistedRecord): Promise<void> {
    abort()
    const edited = updated.manualRecognition !== null || updated.manualCallsign !== null || updated.calleeCallsign !== null
    const applied = appliedQuery.value
    const matches = (!applied.callsign || updated.effectiveCallsign === applied.callsign)
      && (!applied.editedOnly || edited) && (!applied.reviewedOnly || updated.reviewed)
    if (matches) {
      records.value = records.value.map(row => row.id === updated.id ? { ...row, ...updated } : row)
    }
    else {
      removeRecord(updated.id)
      await reload()
    }
  }

  function removeRecord(id: string): void {
    records.value = records.value.filter(row => row.id !== id)
    total.value = Math.max(0, total.value - 1)
  }
  function clear(): void {
    abort()
    records.value = []
    total.value = 0
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
      isLoading: readonly(isLoading),
      disabled: computed(() => !options.canChange()),
    },
    actions: { setSearchInput, setPageInput, setEditedOnly, setReviewedOnly, searchCallsign, applyFilters, clearCallsignSearch, changePage, goToPage },
    summary,
    reload,
    abort,
    updateRecord,
    removeRecord,
    clear,
  }
}
