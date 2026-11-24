<script setup lang="ts">
import type { PublicStats } from '@iaxweb/contracts'
import { publicStatsSchema } from '@iaxweb/contracts'
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import StatsBarChart from '../components/StatsBarChart.vue'
import StatsHeatmap from '../components/StatsHeatmap.vue'

const emit = defineEmits<{ pageReady: [] }>()
const stats = shallowRef<PublicStats>()
const state = ref<'loading' | 'ready' | 'unavailable' | 'error'>('loading')
const timeFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', hourCycle: 'h23', minute: '2-digit', timeZone: 'Asia/Shanghai' })
const numberFormat = new Intl.NumberFormat('zh-CN')
let request: AbortController | undefined

const view = computed(() => {
  if (!stats.value)
    return undefined
  const { history, today } = stats.value
  const recentDays = [...history.days, today.day]
  const activityDays = history.days.slice(-28)
  const hourlyCounts = Array.from<number>({ length: 24 }).fill(0)
  const weekdayCounts = Array.from<number>({ length: 7 }).fill(0)
  const heatmap = Array.from({ length: 7 }, () => Array.from<number>({ length: 24 }).fill(0))

  for (const day of activityDays) {
    const weekday = (new Date(`${day.date}T00:00:00Z`).getUTCDay() + 6) % 7
    const row = heatmap[weekday]!
    weekdayCounts[weekday]! += 1
    day.hourlyCounts.forEach((count, hour) => {
      hourlyCounts[hour]! += count
      row[hour]! += count
    })
  }

  return {
    activityRange: `${shortDate(activityDays[0]!.date)} – ${shortDate(activityDays.at(-1)!.date)}`,
    daily: recentDays.map((day, index) => ({
      highlighted: day === today.day,
      label: day.date,
      tick: [0, 7, 14, 21].includes(index) || day === today.day ? shortDate(day.date) : '',
      value: day.hourlyCounts.reduce((total, count) => total + count, 0),
    })),
    duration: formatDuration(recentDays.reduce((total, day) => total + day.voicedMs, 0)),
    heatmap: heatmap.map((row, weekday) => row.map(count => count / weekdayCounts[weekday]!)),
    hourly: hourlyCounts.map((count, hour) => ({
      label: `${hourLabel(hour)}–${hourLabel(hour + 1)}`,
      tick: hour % 6 === 0 || hour === 23 ? hourLabel(hour) : '',
      value: count,
    })),
    recentRange: `${shortDate(recentDays[0]!.date)} – ${shortDate(today.day.date)}`,
    todayCutoff: timeFormat.format(new Date(today.updatedAt)),
  }
})

onMounted(() => {
  emit('pageReady')
  void load()
})
onBeforeUnmount(() => request?.abort())

async function load(): Promise<void> {
  const controller = new AbortController()
  request = controller
  state.value = 'loading'
  try {
    const response = await fetch('/api/stats', { signal: controller.signal })
    if (response.status === 404) {
      state.value = 'unavailable'
      return
    }
    if (!response.ok)
      throw new Error('Statistics request failed')
    stats.value = publicStatsSchema.parse(await response.json())
    state.value = 'ready'
  }
  catch {
    if (!controller.signal.aborted)
      state.value = 'error'
  }
}

function shortDate(date: string): string {
  return date.slice(5).replace('-', '/')
}

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000)
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor(seconds / 60) % 60
  if (hours > 0)
    return `${numberFormat.format(hours)} 小时 ${minutes} 分钟`
  if (minutes > 0)
    return `${minutes} 分 ${seconds % 60} 秒`
  if (seconds === 0 && milliseconds > 0)
    return '不足 1 秒'
  return `${seconds} 秒`
}
</script>

<template>
  <main class="stats-page" aria-labelledby="stats-title">
    <div class="stats-content">
      <div class="stats-heading">
        <div class="stats-intro">
          <h1 id="stats-title">
            通联统计
          </h1>
          <p>统计联网到杭州Hub时的通联。非联网时间段的中继通联无法统计。</p>
        </div>
        <section v-if="view" class="stats-total" aria-labelledby="stats-total-title">
          <h2 id="stats-total-title">
            累计通联时长
          </h2>
          <p>{{ view.duration }}</p>
          <span>{{ view.recentRange }}</span>
        </section>
      </div>

      <p v-if="state === 'loading'" class="stats-notice" role="status">
        正在加载统计数据…
      </p>
      <p v-else-if="state === 'unavailable'" class="stats-notice" role="status">
        当前未启用语音记录，暂无统计数据。
      </p>
      <div v-else-if="state === 'error'" class="stats-notice" role="status">
        <span>统计暂时无法加载。</span>
        <button type="button" @click="load">
          重试
        </button>
      </div>

      <template v-else-if="view && stats">
        <p v-if="stats.stale" class="stats-notice stats-notice-stale" role="status">
          统计刷新失败，正在显示上次更新的数据。
        </p>
        <div class="stats-panels">
          <section class="stats-panel" aria-labelledby="stats-daily-title">
            <div class="stats-panel-heading">
              <h2 id="stats-daily-title">
                每日语音条数
              </h2>
              <span class="stats-panel-meta">{{ view.recentRange }}</span>
              <span class="stats-panel-meta">截至 {{ view.todayCutoff }}</span>
            </div>
            <StatsBarChart :points="view.daily" />
          </section>
          <section class="stats-panel" aria-labelledby="stats-hourly-title">
            <div class="stats-panel-heading">
              <h2 id="stats-hourly-title">
                24 小时活跃分布
              </h2>
              <span class="stats-panel-meta">{{ view.activityRange }}</span>
            </div>
            <StatsBarChart :points="view.hourly" start-at-peak />
          </section>
          <section class="stats-panel stats-panel-wide" aria-labelledby="stats-heatmap-title">
            <div class="stats-panel-heading">
              <h2 id="stats-heatmap-title">
                星期 × 小时热力图
              </h2>
              <span class="stats-panel-meta">{{ view.activityRange }}</span>
            </div>
            <StatsHeatmap :rows="view.heatmap" />
          </section>
        </div>
      </template>
    </div>
  </main>
</template>

<style src="./StatsPage.css"></style>
