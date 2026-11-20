<script setup lang="ts">
import type { CountyState } from '../services/map-county-status'
import type { Geometry } from '../services/map-geometry'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, shallowRef } from 'vue'
import zhejiangUrl from '../../assets/zhejiang.geojson?url'
import { useCountyMap } from '../composables/use-county-map'
import { useMapInteraction } from '../composables/use-map-interaction'
import { mapStates } from '../services/map-county-status'
import { geometryPath, MAP_HEIGHT, MAP_WIDTH, SIX_DIGIT_CELL_HEIGHT, SIX_DIGIT_LABEL_MIN_HEIGHT_PX, SIX_DIGIT_LATITUDE_STEP, SIX_DIGIT_LONGITUDE_STEP } from '../services/map-geometry'
import { createGridLabels, createGridPaths, createVisibleSixDigitGridLabels } from '../services/map-grid'
import { useStatusStore } from '../stores/status-store'

const emit = defineEmits<{ pageReady: [] }>()
const { countyShapes, mapLoadState, load } = useCountyMap(zhejiangUrl)
const { canvasSize, renderedSize, isDragging, mapElement, viewport, canvasOffset, viewportViewBox, handleMapWheel, handlePointerDown, handlePointerMove, handlePointerEnd } = useMapInteraction()
const { statusSnapshot } = storeToRefs(useStatusStore())
const states = computed(() => mapStates(statusSnapshot.value))
const gridContext = computed(() => ({ size: canvasSize.value, offset: canvasOffset.value, viewport: viewport.value }))
const showSixDigitGridLabels = computed(() => SIX_DIGIT_CELL_HEIGHT * renderedSize.value.height / (canvasSize.value.height / viewport.value.zoom) > SIX_DIGIT_LABEL_MIN_HEIGHT_PX)
const visibleSixDigitGridLabels = computed(() => showSixDigitGridLabels.value ? createVisibleSixDigitGridLabels(gridContext.value) : [])
const sixDigitGridPaths = computed(() => createGridPaths(gridContext.value, SIX_DIGIT_LONGITUDE_STEP, SIX_DIGIT_LATITUDE_STEP))
const gridPaths = computed(() => createGridPaths(gridContext.value))
const gridLabels = computed(() => createGridLabels(gridContext.value))
const repeaterMarkers = computed(() => countyShapes.value.flatMap(({ center, gb, name }) => {
  const state = states.value.get(gb)
  return center && state ? [{ center, gb, name, state }] : []
}))
const markerRadius = computed(() => 6.5 * canvasSize.value.width / (renderedSize.value.width * viewport.value.zoom))
const markerLabels: Record<CountyState, string> = {
  local: '本地发射',
  offline: '离线',
  online: '在线',
  remote: '远程发射',
  system: '系统发射',
}
const showCoverage = ref(false)
const coverageState = ref<'idle' | 'loading' | 'ready' | 'failed'>('idle')
const coverageBands = shallowRef<{ dbm: number, fillOpacity: number, opacity: number, path: string }[]>([])
const coverageVisible = computed(() => showCoverage.value && coverageState.value === 'ready')

onMounted(async () => {
  await load()
  emit('pageReady')
})

async function toggleCoverage(): Promise<void> {
  showCoverage.value = !showCoverage.value
  if (!showCoverage.value || coverageState.value === 'ready' || coverageState.value === 'loading')
    return
  coverageState.value = 'loading'
  try {
    const response = await fetch('/api/coverage/BR5AI.geojson')
    if (!response.ok)
      throw new Error(`Unable to load coverage: ${response.status}`)
    const data = await response.json() as { features: { geometry: Geometry, properties: { dbm: number } }[] }
    if (!data.features.length)
      throw new Error('Empty coverage layer')
    let previousOpacity = 0
    coverageBands.value = data.features
      .sort((a, b) => a.properties.dbm - b.properties.dbm)
      .map(({ geometry, properties }, index, bands) => {
        const opacity = Math.max(0, 100 - 8 * (bands.length - 1 - index)) / 100
        // Contours nest. Account for the opacity already painted by weaker bands.
        const fillOpacity = (opacity - previousOpacity) / (1 - previousOpacity)
        previousOpacity = opacity
        return { dbm: properties.dbm, fillOpacity, opacity, path: geometryPath(geometry) }
      })
    coverageState.value = 'ready'
  }
  catch {
    coverageState.value = 'failed'
  }
}
</script>

<template>
  <main class="map-view" aria-label="浙江省县级行政区划地图">
    <svg
      ref="mapElement"
      class="zhejiang-map"
      :class="{ 'has-coverage': coverageVisible, 'is-dragging': isDragging, 'is-zoomed': viewport.zoom > 1 }"
      :viewBox="viewportViewBox"
      role="img"
      aria-label="浙江省县级行政区划地图，可使用鼠标滚轮缩放，放大后可拖动"
      @lostpointercapture="handlePointerEnd"
      @pointercancel="handlePointerEnd"
      @pointerdown="handlePointerDown"
      @pointermove="handlePointerMove"
      @pointerup="handlePointerEnd"
      @wheel="handleMapWheel"
    >
      <g class="maidenhead-grid maidenhead-grid-six" aria-label="Maidenhead 六位网格" aria-hidden="true">
        <path v-for="path in sixDigitGridPaths" :key="path" :d="path" />
      </g>
      <g class="maidenhead-grid" aria-label="Maidenhead 四位网格" aria-hidden="true">
        <path v-for="path in gridPaths" :key="path" :d="path" />
      </g>
      <path v-for="county in countyShapes" :key="county.gb" class="county-shape" :d="county.path" fill-rule="evenodd">
        <title>{{ county.name }}</title>
      </path>
      <g v-if="coverageVisible" class="map-coverage-layer" aria-hidden="true">
        <path v-for="band in coverageBands" :key="band.dbm" :d="band.path" :fill-opacity="band.fillOpacity" fill-rule="evenodd" />
      </g>
      <g v-if="!showSixDigitGridLabels" class="maidenhead-grid-labels" aria-label="Maidenhead 四位网格文字" aria-hidden="true">
        <text v-for="label in gridLabels" :key="label.grid" :x="label.position[0]" :y="label.position[1]">
          {{ label.grid }}
        </text>
      </g>
      <g v-else class="maidenhead-grid-labels maidenhead-grid-labels-six" aria-label="Maidenhead 六位网格文字" aria-hidden="true">
        <text v-for="label in visibleSixDigitGridLabels" :key="label.grid" :x="label.position[0]" :y="label.position[1]">
          {{ label.grid }}
        </text>
      </g>
      <g class="county-boundaries" aria-hidden="true">
        <path v-for="county in countyShapes" :key="county.gb" class="county-boundary" :d="county.path" />
      </g>
      <text v-if="mapLoadState === 'failed'" class="map-state" :x="MAP_WIDTH / 2" :y="MAP_HEIGHT / 2" text-anchor="middle">
        地图数据加载失败
      </text>
      <text v-else-if="mapLoadState === 'ready' && !countyShapes.length" class="map-state" :x="MAP_WIDTH / 2" :y="MAP_HEIGHT / 2" text-anchor="middle">
        暂无地图数据
      </text>
      <g aria-label="中继状态">
        <circle
          v-for="marker in repeaterMarkers"
          :key="marker.gb"
          class="repeater-marker"
          :class="marker.state"
          :cx="marker.center[0]"
          :cy="marker.center[1]"
          :r="markerRadius"
        >
          <title>{{ marker.name }} · {{ markerLabels[marker.state] }}</title>
        </circle>
      </g>
    </svg>
    <div class="map-coverage-panel">
      <button type="button" :aria-pressed="showCoverage" @click="toggleCoverage">
        BR5AI 覆盖预测
      </button>
      <div v-if="coverageVisible" class="map-coverage-scale" aria-label="预测信号强度">
        <span>{{ coverageBands[0]?.dbm }} dBm</span>
        <div class="map-coverage-swatches" aria-hidden="true">
          <i v-for="band in coverageBands" :key="band.dbm" :style="{ opacity: band.opacity }" />
        </div>
        <span>{{ coverageBands.at(-1)?.dbm }} dBm</span>
      </div>
      <p v-else-if="showCoverage" role="status">
        {{ coverageState === 'failed' ? '覆盖图层加载失败' : '正在加载覆盖图层…' }}
      </p>
    </div>
  </main>
</template>

<style src="./MapPage.css"></style>
