import { onBeforeUnmount, onMounted, ref } from 'vue'

const DEFAULT_INTERVAL_MS = 60_000

interface ConditionalAutoRefreshOptions {
  canRefresh: () => boolean
  intervalMs?: number
  refresh: () => Promise<void>
}

// Refreshes only when the page is visible, online, and at the top. The caller
// supplies page-specific eligibility and marks each successful manual or auto refresh.
export function useConditionalAutoRefresh(options: ConditionalAutoRefreshOptions): {
  markRefreshed: () => void
} {
  const isAtPageTop = ref(true)
  const isOnline = ref(navigator.onLine)
  const isPageVisible = ref(document.visibilityState === 'visible')
  const lastSuccessfulRefreshAt = ref<number | null>(null)
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  let refreshTimer: ReturnType<typeof setInterval> | undefined

  onMounted(() => {
    updatePageVisibility()
    updateOnlineStatus()
    updateScrollPosition()
    window.addEventListener('online', handleOnlineStatusChange)
    window.addEventListener('offline', handleOnlineStatusChange)
    window.addEventListener('scroll', updateScrollPosition, { passive: true })
    document.addEventListener('visibilitychange', handlePageVisibilityChange)
    refreshTimer = setInterval(() => void refreshIfStale(), intervalMs)
  })

  onBeforeUnmount(() => {
    window.removeEventListener('online', handleOnlineStatusChange)
    window.removeEventListener('offline', handleOnlineStatusChange)
    window.removeEventListener('scroll', updateScrollPosition)
    document.removeEventListener('visibilitychange', handlePageVisibilityChange)
    if (refreshTimer !== undefined)
      clearInterval(refreshTimer)
  })

  function markRefreshed(): void {
    lastSuccessfulRefreshAt.value = Date.now()
  }

  function updatePageVisibility(): void {
    isPageVisible.value = document.visibilityState === 'visible'
  }

  function updateOnlineStatus(): void {
    isOnline.value = navigator.onLine
  }

  function handleOnlineStatusChange(): void {
    updateOnlineStatus()
    void refreshIfStale()
  }

  function handlePageVisibilityChange(): void {
    updatePageVisibility()
    void refreshIfStale()
  }

  function updateScrollPosition(): void {
    isAtPageTop.value = window.scrollY === 0
  }

  function isRefreshStale(): boolean {
    return lastSuccessfulRefreshAt.value === null
      || Date.now() - lastSuccessfulRefreshAt.value >= intervalMs
  }

  async function refreshIfStale(): Promise<void> {
    if (options.canRefresh() && isAtPageTop.value && isOnline.value && isPageVisible.value && isRefreshStale())
      await options.refresh()
  }

  return { markRefreshed }
}
