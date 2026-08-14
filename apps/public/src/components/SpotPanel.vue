<script setup lang="ts">
import type { SpotEvent } from '@iaxweb/contracts'

defineProps<{ spots: SpotEvent[] }>()

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
    </h2>
    <ul v-if="spots.length" class="spot-list">
      <li v-for="spot in spots" :key="`${spot.id}|${spot.callsign}|${spot.at}`" class="spot-item">
        <span class="spot-callsign">{{ spot.callsign }}</span>
        <time class="spot-time" :datetime="spot.at">{{ relativeTime(spot.at) }}</time>
      </li>
    </ul>
    <p v-else class="spot-empty">
      暂无呼号
    </p>
  </aside>
</template>
