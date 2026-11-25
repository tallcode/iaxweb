<script setup lang="ts">
import type { Geometry } from '../services/map-geometry'
import { storeToRefs } from 'pinia'
import { computed, onMounted, shallowReactive } from 'vue'
import zhejiangUrl from '../../assets/zhejiang.geojson?url'
import MapCoverageNotice from '../components/MapCoverageNotice.vue'
import { useCountyMap } from '../composables/use-county-map'
import { useMapInteraction } from '../composables/use-map-interaction'
import { mapRepeaterMarkers } from '../services/map-county-status'
import { geometryPath, MAP_HEIGHT, MAP_WIDTH, SIX_DIGIT_CELL_HEIGHT, SIX_DIGIT_LABEL_MIN_HEIGHT_PX, SIX_DIGIT_LATITUDE_STEP, SIX_DIGIT_LONGITUDE_STEP } from '../services/map-geometry'
import { createGridLabels, createGridPaths, createVisibleSixDigitGridLabels } from '../services/map-grid'
import { repeaterStateLabels } from '../services/status-presentation'
import { useStatusStore } from '../stores/status-store'

const emit = defineEmits<{ pageReady: [] }>()
const { countyShapes, mapLoadState, load } = useCountyMap(zhejiangUrl)
const { canvasSize, renderedSize, isDragging, mapElement, viewport, canvasOffset, viewportViewBox, handleMapWheel, handlePointerDown, handlePointerMove, handlePointerEnd } = useMapInteraction()
const { statusSnapshot } = storeToRefs(useStatusStore())
const gridContext = computed(() => ({ size: canvasSize.value, offset: canvasOffset.value, viewport: viewport.value }))
const showSixDigitGridLabels = computed(() => SIX_DIGIT_CELL_HEIGHT * renderedSize.value.height / (canvasSize.value.height / viewport.value.zoom) > SIX_DIGIT_LABEL_MIN_HEIGHT_PX)
const visibleSixDigitGridLabels = computed(() => showSixDigitGridLabels.value ? createVisibleSixDigitGridLabels(gridContext.value) : [])
const sixDigitGridPaths = computed(() => createGridPaths(gridContext.value, SIX_DIGIT_LONGITUDE_STEP, SIX_DIGIT_LATITUDE_STEP))
const gridPaths = computed(() => createGridPaths(gridContext.value))
const gridLabels = computed(() => createGridLabels(gridContext.value))
const repeaterMarkers = computed(() => mapRepeaterMarkers(statusSnapshot.value, countyShapes.value).map(marker => ({
  ...marker,
  coverage: coverageTarget(marker.name, marker.key),
})))
const markerRadius = computed(() => 6.5 * canvasSize.value.width / (renderedSize.value.width * viewport.value.zoom))
const coverageButtons = ['BR5AI', 'BR5BB', 'BR5AF', 'BR5AO'].map(callsign => coverageTarget(callsign))
interface CoverageTarget { key: string, name: string, callsign: string | undefined }
interface CoverageBand { dbm: number, fillOpacity: number, opacity: number, path: string }
type CoverageLayer = { name: string } & ({ state: 'loading' | 'unavailable' | 'failed' } | { state: 'ready', bands: CoverageBand[] })

const activeCoverage = shallowReactive(new Set<string>())
const coverageLayers = shallowReactive(new Map<string, CoverageLayer>())
const visibleCoverage = computed(() => [...coverageLayers].flatMap(([key, layer]) =>
  activeCoverage.has(key) && layer.state === 'ready' ? [{ callsign: key, bands: layer.bands }] : [],
))
const coverageScale = computed(() => visibleCoverage.value[0]?.bands)

onMounted(async () => {
  await load()
  emit('pageReady')
})

function coverageTarget(name: string, fallbackKey = name): CoverageTarget {
  const normalized = name.trim().toUpperCase()
  const callsign = /^[A-Z0-9][\w-]{0,31}$/.test(normalized) ? normalized : undefined
  return { key: callsign ?? fallbackKey, name, callsign }
}

async function toggleCoverage({ key, name, callsign }: CoverageTarget): Promise<void> {
  if (activeCoverage.delete(key))
    return
  activeCoverage.add(key)
  if (!callsign) {
    coverageLayers.set(key, { name, state: 'unavailable' })
    return
  }
  const state = coverageLayers.get(key)?.state
  if (state === 'ready' || state === 'loading')
    return
  coverageLayers.set(key, { name, state: 'loading' })
  try {
    const response = await fetch(`/api/coverage/${callsign}.geojson`)
    if (response.status === 404) {
      coverageLayers.set(key, { name, state: 'unavailable' })
      return
    }
    if (!response.ok)
      throw new Error(`Unable to load coverage: ${response.status}`)
    const data = await response.json() as { features: { geometry: Geometry, properties: { dbm: number } }[] }
    if (!data.features.length)
      throw new Error('Empty coverage layer')
    let previousOpacity = 0
    const bands = data.features
      .sort((a, b) => a.properties.dbm - b.properties.dbm)
      .map(({ geometry, properties }, index, bands) => {
        const opacity = Math.max(0, 100 - 8 * (bands.length - 1 - index)) / 100
        // Contours nest. Account for the opacity already painted by weaker bands.
        const fillOpacity = (opacity - previousOpacity) / (1 - previousOpacity)
        previousOpacity = opacity
        return { dbm: properties.dbm, fillOpacity, opacity, path: geometryPath(geometry) }
      })
    coverageLayers.set(key, { name, state: 'ready', bands })
  }
  catch {
    coverageLayers.set(key, { name, state: 'failed' })
  }
}
</script>

<template>
  <main class="map-view" aria-label="浙江省县级行政区划地图">
    <svg
      ref="mapElement"
      class="zhejiang-map"
      :class="{ 'has-coverage': visibleCoverage.length > 0, 'is-dragging': isDragging, 'is-zoomed': viewport.zoom > 1 }"
      :viewBox="viewportViewBox"
      role="group"
      aria-label="浙江省县级行政区划地图，可使用鼠标滚轮缩放，放大后可拖动"
      @lostpointercapture.self="handlePointerEnd"
      @pointercancel="handlePointerEnd"
      @pointerdown="handlePointerDown"
      @pointerleave="handlePointerEnd"
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
      <g v-for="layer in visibleCoverage" :key="layer.callsign" class="map-coverage-layer" :data-callsign="layer.callsign" aria-hidden="true">
        <path v-for="band in layer.bands" :key="band.dbm" :d="band.path" :fill-opacity="band.fillOpacity" fill-rule="evenodd" />
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
          :key="marker.key"
          class="repeater-marker"
          :class="marker.state"
          :cx="marker.center[0]"
          :cy="marker.center[1]"
          :r="markerRadius"
          role="button"
          :aria-label="`${marker.name} · ${repeaterStateLabels[marker.state]} · 覆盖预测`"
          :aria-pressed="activeCoverage.has(marker.coverage.key)"
          @click="toggleCoverage(marker.coverage)"
        >
          <title>{{ marker.name }} · {{ repeaterStateLabels[marker.state] }}</title>
        </circle>
      </g>
    </svg>
    <div class="map-coverage-panel">
      <div class="map-coverage-buttons" role="group" aria-label="中继覆盖预测">
        <span class="map-coverage-label" aria-hidden="true">覆盖预测</span>
        <button
          v-for="button in coverageButtons"
          :key="button.key"
          type="button"
          :aria-label="`${button.name} 覆盖预测`"
          :aria-pressed="activeCoverage.has(button.key)"
          @click="toggleCoverage(button)"
        >
          {{ button.name }}
        </button>
      </div>
      <div v-if="coverageScale" class="map-coverage-scale" aria-label="预测信号强度">
        <span>{{ coverageScale[0]?.dbm }} dBm</span>
        <div class="map-coverage-swatches" aria-hidden="true">
          <i v-for="band in coverageScale" :key="band.dbm" :style="{ opacity: band.opacity }" />
        </div>
        <span>{{ coverageScale.at(-1)?.dbm }} dBm</span>
      </div>
      <MapCoverageNotice
        v-for="[key, layer] in coverageLayers"
        :key="key"
        :name="layer.name"
        :state="activeCoverage.has(key) ? layer.state : 'inactive'"
      />
    </div>
  </main>
</template>

<style src="./MapPage.css"></style>
