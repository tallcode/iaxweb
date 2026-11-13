import { onBeforeUnmount, onMounted, ref } from 'vue'

// Keep narrow desktop windows compact, and include touch devices whose viewport
// is wider in landscape or when the browser requests a desktop-sized page.
const MOBILE_LAYOUT_QUERY = '(max-width: 680px), (hover: none) and (pointer: coarse) and (max-width: 1024px), (hover: none) and (pointer: coarse) and (max-height: 680px)'

export function useMobileLayout() {
  const mediaQuery = window.matchMedia(MOBILE_LAYOUT_QUERY)
  const isMobile = ref(mediaQuery.matches)

  const sync = (): void => {
    isMobile.value = mediaQuery.matches
  }

  onMounted(() => {
    sync()
    mediaQuery.addEventListener('change', sync)
  })
  onBeforeUnmount(() => mediaQuery.removeEventListener('change', sync))

  return isMobile
}
