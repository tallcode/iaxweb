<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref } from 'vue'
import zhejiangUrl from '../../assets/zhejiang.geojson?url'
import { countyState, mapStates } from '../services/map-county-status'
import { useStatusStore } from '../stores/status-store'

type Position = [number, number]
type Polygon = Position[][]
interface Geometry {
  coordinates: Polygon | Polygon[]
  type: 'Polygon' | 'MultiPolygon'
}
interface CountyFeature {
  geometry: Geometry
  properties: { gb: string, name?: string }
}
interface FeatureCollection {
  features: CountyFeature[]
}

const MAP_WIDTH = 1_000
const MAP_HEIGHT = 840
const PADDING = 48
const WEST = 118.028267
const EAST = 122.833454
const SOUTH = 27.167389
const NORTH = 31.182732

const counties = ref<CountyFeature[]>([])
const loadFailed = ref(false)
const { statusSnapshot } = storeToRefs(useStatusStore())
const states = computed(() => mapStates(statusSnapshot.value))

const countyPaths = computed(() => counties.value.map(feature => ({
  gb: feature.properties.gb,
  name: feature.properties.name ?? '未命名区域',
  path: geometryPath(feature.geometry),
  state: countyState(feature.properties.gb, states.value),
})))

onMounted(async () => {
  try {
    const response = await fetch(zhejiangUrl)
    if (!response.ok)
      throw new Error(`Unable to load map: ${response.status}`)
    const data = await response.json() as FeatureCollection
    counties.value = data.features
  }
  catch {
    loadFailed.value = true
  }
})

function geometryPath(geometry: Geometry): string {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates as Polygon] : geometry.coordinates as Polygon[]
  return polygons.flatMap(polygon => polygon.map(ringPath)).join('')
}

function ringPath(ring: Position[]): string {
  return `${ring.map(([longitude, latitude], index) => {
    const x = PADDING + (longitude - WEST) / (EAST - WEST) * (MAP_WIDTH - PADDING * 2)
    const y = MAP_HEIGHT - PADDING - (latitude - SOUTH) / (NORTH - SOUTH) * (MAP_HEIGHT - PADDING * 2)
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`
  }).join('')}Z`
}
</script>

<template>
  <main class="map-view" aria-label="浙江省县级行政区划地图">
    <svg v-if="countyPaths.length" class="zhejiang-map" :viewBox="`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`" role="img" aria-label="浙江省县级行政区划地图">
      <path v-for="county in countyPaths" :key="county.gb" class="county-shape" :class="county.state" :d="county.path" fill-rule="evenodd">
        <title>{{ county.name }}</title>
      </path>
    </svg>
    <p v-else-if="loadFailed" class="map-state">
      地图数据加载失败
    </p>
    <p v-else class="map-state">
      正在加载浙江省地图…
    </p>
  </main>
</template>
