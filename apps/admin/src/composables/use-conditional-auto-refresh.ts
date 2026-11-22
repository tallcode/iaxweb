import { onBeforeUnmount, onMounted, ref } from 'vue'
import { usePageTopPull } from './use-page-top-pull'

const DEFAULT_INTERVAL_MS = 60_000
const MINIMUM_REFRESH_INTERVAL_MS = 30_000

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
  const isOnline = ref(navigator.onLine)
  const isPageVisible = ref(document.visibilityState === 'visible')
  const lastSuccessfulRefreshAt = ref<number | null>(null)
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  let refreshTimer: ReturnType<typeof setInterval> | undefined

  usePageTopPull(() => void refreshIfStale())

  onMounted(() => {
    updatePageVisibility()
    updateOnlineStatus()
    window.addEventListener('online', handleOnlineStatusChange)
    window.addEventListener('offline', handleOnlineStatusChange)
    document.addEventListener('visibilitychange', handlePageVisibilityChange)
    refreshTimer = setInterval(() => void refreshIfStale(), intervalMs)
  })

  onBeforeUnmount(() => {
    window.removeEventListener('online', handleOnlineStatusChange)
    window.removeEventListener('offline', handleOnlineStatusChange)
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

  function isRefreshStale(): boolean {
    return lastSuccessfulRefreshAt.value === null
      || Date.now() - lastSuccessfulRefreshAt.value >= MINIMUM_REFRESH_INTERVAL_MS
  }

  async function refreshIfStale(): Promise<void> {
    if (options.canRefresh() && window.scrollY <= 0 && isOnline.value && isPageVisible.value && isRefreshStale())
      await options.refresh()
  }

  return { markRefreshed }
}
