<script setup lang="ts">
import { computed, ref } from 'vue'

const props = defineProps<{ rows: number[][] }>()
const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const highActivityStart = 100
const activityThresholds = [1.5, 5.5, 15, 40, 60, highActivityStart]
const highActivityLevels = 3
const legendLevels = [0, 1, 2, 3, 5, 7, 9]
const formatNumber = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format
const table = ref<HTMLTableElement>()
const active = ref<{ day: number, hour: number }>()
const peak = computed(() => {
  let peakDay = 0
  let peakHour = 0
  let maximum = 0
  props.rows.forEach((row, day) => row.forEach((value, hour) => {
    if (value > maximum) {
      peakDay = day
      peakHour = hour
      maximum = value
    }
  }))
  return { day: peakDay, hour: peakHour, value: maximum }
})
const current = computed(() => active.value ?? peak.value)

function focusCell(day: number, hour: number): void {
  table.value?.querySelector<HTMLButtonElement>(`[data-cell="${day}-${hour}"]`)?.focus()
}

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`
}

function level(value: number): number {
  if (value === 0)
    return 0

  const band = activityThresholds.findIndex(limit => value <= limit)
  if (band !== -1)
    return band + 1

  const highRangePosition = (value - highActivityStart) / (peak.value.value - highActivityStart)
  return activityThresholds.length + Math.ceil(highActivityLevels * highRangePosition)
}
</script>

<template>
  <div class="stats-heatmap">
    <div class="stats-heatmap-key">
      <p class="stats-chart-reading">
        {{ weekdays[current.day] }} {{ hourLabel(current.hour) }}–{{ hourLabel(current.hour + 1) }}
        <strong>平均 {{ formatNumber(rows[current.day]![current.hour]!) }} 条</strong>
      </p>
      <div class="stats-heatmap-scale" role="img" aria-label="颜色越亮，日均条数越多">
        <span>低</span>
        <i v-for="legendLevel in legendLevels" :key="legendLevel" :data-level="legendLevel" />
        <span>高</span>
      </div>
    </div>
    <div class="stats-heatmap-scroll">
      <table ref="table" aria-label="按星期及小时统计的日均语音条数">
        <thead>
          <tr>
            <td />
            <th v-for="hour in 24" :key="hour" scope="col" :aria-label="hourLabel(hour - 1)">
              <span v-if="(hour - 1) % 2 === 0" aria-hidden="true">{{ hourLabel(hour - 1).slice(0, 2) }}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, day) in rows" :key="day">
            <th scope="row">
              {{ weekdays[day] }}
            </th>
            <td v-for="(value, hour) in row" :key="hour">
              <button
                type="button"
                :aria-label="`${weekdays[day]} ${hourLabel(hour)}–${hourLabel(hour + 1)}，平均 ${formatNumber(value)} 条`"
                :class="{ 'is-active': current.day === day && current.hour === hour }"
                :data-cell="`${day}-${hour}`"
                :data-level="level(value)"
                :tabindex="current.day === day && current.hour === hour ? 0 : -1"
                @click="active = { day, hour }"
                @focus="active = { day, hour }"
                @keydown.down.prevent="focusCell(day + 1, hour)"
                @keydown.left.prevent="focusCell(day, hour - 1)"
                @keydown.right.prevent="focusCell(day, hour + 1)"
                @keydown.up.prevent="focusCell(day - 1, hour)"
                @pointerenter="active = { day, hour }"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
