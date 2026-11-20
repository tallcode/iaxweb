<script setup lang="ts">
import { computed, ref } from 'vue'

const props = defineProps<{
  average?: boolean
  points: { highlighted?: boolean, label: string, tick?: string, value: number }[]
}>()

const plot = ref<HTMLElement>()
const activeIndex = ref<number>()
const peakIndex = computed(() => props.points.reduce((peak, point, index) =>
  point.value > props.points[peak]!.value ? index : peak, 0))
const currentIndex = computed(() => activeIndex.value ?? (props.average ? peakIndex.value : props.points.length - 1))
const currentPoint = computed(() => props.points[currentIndex.value])
const step = computed(() => {
  const maximum = props.points[peakIndex.value]?.value ?? 0
  const target = Math.max(maximum / 4, props.average ? 0.01 : 1)
  const magnitude = 10 ** Math.floor(Math.log10(target))
  return magnitude * ([1, 2, 5, 10].find(factor => factor * magnitude >= target) ?? 10)
})
const formatNumber = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format

function focusPoint(index: number): void {
  plot.value?.querySelectorAll('button')[index]?.focus()
}
</script>

<template>
  <div v-if="currentPoint" class="stats-chart">
    <p class="stats-chart-reading">
      {{ currentPoint.label }} <strong>{{ average ? '平均 ' : '' }}{{ formatNumber(currentPoint.value) }} 条</strong>
    </p>
    <div class="stats-chart-grid" :style="{ '--bars': points.length }">
      <div class="stats-chart-scale" aria-hidden="true">
        <span v-for="index in 5" :key="index" :style="{ bottom: `${(index - 1) * 25}%` }">
          {{ formatNumber((index - 1) * step) }}
        </span>
      </div>
      <div ref="plot" class="stats-chart-plot">
        <div class="stats-chart-gridlines" aria-hidden="true" />
        <button
          v-for="(point, index) in points"
          :key="point.label"
          type="button"
          :aria-label="`${point.label}，${average ? '平均 ' : ''}${formatNumber(point.value)} 条`"
          :class="{ 'is-active': index === currentIndex, 'is-highlighted': point.highlighted }"
          :style="{ '--value': `${point.value / (4 * step) * 100}%` }"
          :tabindex="index === currentIndex ? 0 : -1"
          @click="activeIndex = index"
          @focus="activeIndex = index"
          @keydown.left.prevent="focusPoint(index - 1)"
          @keydown.right.prevent="focusPoint(index + 1)"
          @pointerenter="activeIndex = index"
        >
          <span />
        </button>
      </div>
      <div class="stats-chart-dates" aria-hidden="true">
        <span v-for="(point, index) in points" v-show="point.tick" :key="point.label" :style="{ gridColumn: index + 1 }">
          {{ point.tick }}
        </span>
      </div>
    </div>
  </div>
</template>
