import type { Ref } from 'vue'
import { onBeforeUnmount, onMounted } from 'vue'

export function useToolbarHeight(element: Ref<HTMLElement | undefined>): void {
  let observer: ResizeObserver | undefined
  function sync(): void {
    const height = element.value?.getBoundingClientRect().height
    if (height)
      document.documentElement.style.setProperty('--records-toolbar-height', `${Math.ceil(height)}px`)
  }
  onMounted(() => {
    sync()
    if (typeof ResizeObserver !== 'undefined' && element.value) {
      observer = new ResizeObserver(sync)
      observer.observe(element.value)
    }
  })
  onBeforeUnmount(() => {
    observer?.disconnect()
    document.documentElement.style.removeProperty('--records-toolbar-height')
  })
}
