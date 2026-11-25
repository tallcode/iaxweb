<script setup lang="ts">
import { computed, ref, watch } from 'vue'

const props = defineProps<{
  name: string
  state: 'inactive' | 'loading' | 'ready' | 'unavailable' | 'failed'
}>()

const COVERAGE_LOADING_DELAY_MS = 300
const COVERAGE_LOADING_MINIMUM_MS = 1_000
const COVERAGE_UNAVAILABLE_NOTICE_MS = 5_000
const loadingVisible = ref(false)
const unavailableVisible = ref(false)
let shownAt = 0

watch(() => props.state === 'loading', (loading, _, onCleanup) => {
  if (loading === loadingVisible.value)
    return
  const delay = loading
    ? COVERAGE_LOADING_DELAY_MS
    : Math.max(0, Math.ceil(shownAt + COVERAGE_LOADING_MINIMUM_MS - performance.now()))
  const timer = setTimeout(() => {
    if (loading)
      shownAt = performance.now()
    loadingVisible.value = loading
  }, delay)
  onCleanup(() => clearTimeout(timer))
}, { immediate: true })

watch(() => props.state === 'unavailable' && !loadingVisible.value, (unavailable, _, onCleanup) => {
  unavailableVisible.value = unavailable
  if (!unavailable)
    return
  const timer = setTimeout(() => {
    unavailableVisible.value = false
  }, COVERAGE_UNAVAILABLE_NOTICE_MS)
  onCleanup(() => clearTimeout(timer))
}, { immediate: true })

const message = computed(() => {
  if (loadingVisible.value)
    return '正在加载覆盖图层…'
  if (unavailableVisible.value)
    return '暂无覆盖预测'
  if (props.state === 'failed')
    return '覆盖图层加载失败'
  return ''
})
</script>

<template>
  <p v-if="message" role="status">
    {{ name }} · {{ message }}
  </p>
</template>
