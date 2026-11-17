<script setup lang="ts">
import type { SpotEvent } from '@iaxweb/contracts'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps<{ historyReady: boolean, spots: SpotEvent[] }>()
const spotListElement = ref<HTMLUListElement | null>(null)
const visibleSpotCount = ref(0)
const visibleSpots = computed(() => props.spots.slice(0, visibleSpotCount.value))
const highlightedSpotKeys = ref(new Set<string>())
let resizeObserver: ResizeObserver | undefined

function spotKey(spot: SpotEvent): string {
  return `${spot.id}|${spot.callsign}|${spot.at}`
}

watch(() => ({ historyReady: props.historyReady, keys: props.spots.map(spotKey) }), (current, previous) => {
  if (!current.historyReady || !previous?.historyReady) {
    highlightedSpotKeys.value = new Set()
    return
  }
  const previousKeys = new Set(previous.keys)
  // Existing rows keep their animation when another spot arrives. Initial
  // history stays quiet, and keys that leave the bounded list are discarded.
  highlightedSpotKeys.value = new Set(current.keys.filter(key => highlightedSpotKeys.value.has(key) || !previousKeys.has(key)))
}, { immediate: true })

function syncSpotCapacity(): void {
  const list = spotListElement.value
  if (!list)
    return
  const style = getComputedStyle(list)
  if (style.flexDirection === 'row') {
    visibleSpotCount.value = 3
    return
  }
  const itemHeight = Number.parseFloat(style.getPropertyValue('--spot-item-height'))
  const gap = Number.parseFloat(style.rowGap) || 0
  visibleSpotCount.value = Math.max(0, Math.floor((list.getBoundingClientRect().height + gap) / (itemHeight + gap)))
}

watch(spotListElement, (list) => {
  resizeObserver?.disconnect()
  if (!list)
    return
  resizeObserver ??= new ResizeObserver(syncSpotCapacity)
  resizeObserver.observe(list)
  syncSpotCapacity()
}, { flush: 'post' })

onMounted(() => window.addEventListener('resize', syncSpotCapacity))
onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  window.removeEventListener('resize', syncSpotCapacity)
})

function relativeTime(iso: string): string {
  const then = new Date(iso)
  if (Number.isNaN(then.getTime()))
    return ''
  const seconds = Math.max(0, Math.round((Date.now() - then.getTime()) / 1_000))
  if (seconds < 60)
    return `${seconds}秒前`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60)
    return `${minutes}分钟前`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}小时前` : `${Math.floor(hours / 24)}天前`
}
</script>

<template>
  <aside class="spot-panel" aria-label="AI Spot 最近呼号">
    <h2 class="spot-panel-title">
      AI Spot
      <span
        class="spot-help"
        role="img"
        aria-label="说明：在浙江省业余无线电协会链路联网中继上，用清晰标准的字母解释法说出自己的呼号，AI值机员就有可能把你的呼号记录下来。如果语速太快，声音太轻，信号有干扰可能无法记录或者识别失败"
        title="在浙江省业余无线电协会链路联网中继上，用清晰标准的字母解释法说出自己的呼号，AI值机员就有可能把你的呼号记录下来。&#10;如果语速太快，声音太轻，信号有干扰可能无法记录或者识别失败"
      >?</span>
    </h2>
    <ul v-if="spots.length" ref="spotListElement" class="spot-list">
      <li v-for="spot in visibleSpots" :key="spotKey(spot)" class="spot-item" :class="{ 'is-new': highlightedSpotKeys.has(spotKey(spot)) }" @animationend="highlightedSpotKeys.delete(spotKey(spot))">
        <span class="spot-callsign">{{ spot.callsign }}</span>
        <time class="spot-time" :datetime="spot.at">{{ relativeTime(spot.at) }}</time>
      </li>
    </ul>
    <p v-else-if="historyReady" class="spot-empty">
      暂无呼号
    </p>
  </aside>
</template>

<style src="./SpotPanel.css"></style>
