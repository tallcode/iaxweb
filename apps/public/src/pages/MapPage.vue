<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted } from 'vue'
import zhejiangUrl from '../../assets/zhejiang.geojson?url'
import { useCountyMap } from '../composables/use-county-map'
import { useMapInteraction } from '../composables/use-map-interaction'
import { countyState, mapStates } from '../services/map-county-status'
import { MAP_HEIGHT, MAP_WIDTH, SIX_DIGIT_CELL_HEIGHT, SIX_DIGIT_LABEL_MIN_HEIGHT_PX, SIX_DIGIT_LATITUDE_STEP, SIX_DIGIT_LONGITUDE_STEP } from '../services/map-geometry'
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
const onlineCountyShapes = computed(() => countyShapes.value.filter(county => stateFor(county.gb) === 'online'))
const transmittingCountyShapes = computed(() => countyShapes.value.filter(county => stateFor(county.gb).startsWith('tx-')))
onMounted(async () => {
  await load()
  emit('pageReady')
})
function stateFor(gb: string): string {
  return countyState(gb, states.value)
}
</script>

<template>
  <main class="map-view" aria-label="浙江省县级行政区划地图">
    <svg
      ref="mapElement"
      class="zhejiang-map"
      :class="{ 'is-dragging': isDragging, 'is-zoomed': viewport.zoom > 1 }"
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
      <path v-for="county in countyShapes" :key="county.gb" class="county-shape" :class="stateFor(county.gb)" :d="county.path" fill-rule="evenodd">
        <title>{{ county.name }}</title>
      </path>
      <g class="county-outlines" aria-hidden="true">
        <path v-for="county in onlineCountyShapes" :key="county.gb" class="county-outline" :class="stateFor(county.gb)" :d="county.path" fill="none" fill-rule="evenodd" />
      </g>
      <g class="county-outlines county-transmission-outlines" aria-hidden="true">
        <path v-for="county in transmittingCountyShapes" :key="county.gb" class="county-outline" :class="stateFor(county.gb)" :d="county.path" fill="none" fill-rule="evenodd" />
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
      <text v-if="mapLoadState === 'failed'" class="map-state" :x="MAP_WIDTH / 2" :y="MAP_HEIGHT / 2" text-anchor="middle">
        地图数据加载失败
      </text>
      <text v-else-if="mapLoadState === 'ready' && !countyShapes.length" class="map-state" :x="MAP_WIDTH / 2" :y="MAP_HEIGHT / 2" text-anchor="middle">
        暂无地图数据
      </text>
    </svg>
  </main>
</template>

<style src="./MapPage.css"></style>
