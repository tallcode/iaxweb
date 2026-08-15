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
interface CountyShape {
  gb: string
  name: string
  path: string
}

const MAP_WIDTH = 1_000
const MAP_HEIGHT = 840
const PADDING = 48
const WEST = 118.028267
const EAST = 122.833454
const SOUTH = 27.167389
const NORTH = 31.182732
const STORAGE_KEY = `zhejiang-map:${zhejiangUrl}`

const countyShapes = ref<CountyShape[]>([])
const loadFailed = ref(false)
const { statusSnapshot } = storeToRefs(useStatusStore())
const states = computed(() => mapStates(statusSnapshot.value))

onMounted(async () => {
  try {
    const cached = loadFromStorage()
    const data = cached ?? await loadFromNetwork()
    countyShapes.value = shapesFrom(data)
    if (!cached)
      saveToStorage(data)
  }
  catch {
    loadFailed.value = true
  }
})

function stateFor(gb: string): string {
  return countyState(gb, states.value)
}

async function loadFromNetwork(): Promise<FeatureCollection> {
  const response = await fetch(zhejiangUrl)
  if (!response.ok)
    throw new Error(`Unable to load map: ${response.status}`)
  const data = await response.json() as unknown
  if (!isFeatureCollection(data))
    throw new Error('Invalid map data')
  return data
}

function loadFromStorage(): FeatureCollection | undefined {
  try {
    const cached = localStorage.getItem(STORAGE_KEY)
    if (!cached)
      return undefined
    const data = JSON.parse(cached) as unknown
    if (isFeatureCollection(data))
      return data
    localStorage.removeItem(STORAGE_KEY)
  }
  catch {
    // Privacy mode, disabled storage, quota errors, and invalid cache all fall back to the network.
  }
  return undefined
}

function saveToStorage(data: FeatureCollection): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  }
  catch {
    // The map remains usable when storage is disabled or full.
  }
}

function isFeatureCollection(data: unknown): data is FeatureCollection {
  return typeof data === 'object' && data !== null && 'features' in data && Array.isArray(data.features)
}

function shapesFrom(data: FeatureCollection): CountyShape[] {
  return data.features.map(feature => ({
    gb: feature.properties.gb,
    name: feature.properties.name ?? '未命名区域',
    path: geometryPath(feature.geometry),
  }))
}

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
    <svg class="zhejiang-map" :viewBox="`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`" role="img" aria-label="浙江省县级行政区划地图">
      <path v-for="county in countyShapes" :key="county.gb" class="county-shape" :class="stateFor(county.gb)" :d="county.path" fill-rule="evenodd">
        <title>{{ county.name }}</title>
      </path>
      <text v-if="!countyShapes.length" class="map-state" x="500" y="420" text-anchor="middle">
        {{ loadFailed ? '地图数据加载失败' : '正在加载浙江省地图…' }}
      </text>
    </svg>
  </main>
</template>
