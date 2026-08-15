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

// Keep the viewport aligned to whole four-character Maidenhead squares so no
// partial grids appear along the SVG edges.
const GRID_LONGITUDE_STEP = 2
const GRID_LATITUDE_STEP = 1
const SIX_DIGIT_LONGITUDE_STEP = 1 / 12
const SIX_DIGIT_LATITUDE_STEP = 1 / 24
const MAP_HEIGHT = 840
const MAP_WIDTH = MAP_HEIGHT * 8 / 5
const PADDING = 0
const WEST = 116
const EAST = 124
const SOUTH = 27
const NORTH = 32
const STORAGE_KEY = `zhejiang-map:${zhejiangUrl}`

const countyShapes = ref<CountyShape[]>([])
const loadFailed = ref(false)
const { statusSnapshot } = storeToRefs(useStatusStore())
const states = computed(() => mapStates(statusSnapshot.value))
const sixDigitGridPaths = createGridPaths(SIX_DIGIT_LONGITUDE_STEP, SIX_DIGIT_LATITUDE_STEP)
const gridPaths = createGridPaths()
const gridLabels = createGridLabels()

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
  return `${ring.map((position, index) => `${index === 0 ? 'M' : 'L'}${project(position)}`).join('')}Z`
}

function createGridPaths(
  longitudeStep = GRID_LONGITUDE_STEP,
  latitudeStep = GRID_LATITUDE_STEP,
): string[] {
  const paths: string[] = []
  const bounds = gridBounds(longitudeStep, latitudeStep)
  for (let index = bounds.longitudeStart; index <= bounds.longitudeEnd; index++) {
    const x = project([index * longitudeStep, SOUTH]).split(',')[0]
    paths.push(`M${x},0L${x},${MAP_HEIGHT}`)
  }
  for (let index = bounds.latitudeStart; index <= bounds.latitudeEnd; index++) {
    const y = project([WEST, index * latitudeStep]).split(',')[1]
    paths.push(`M0,${y}L${MAP_WIDTH},${y}`)
  }
  return paths
}

function createGridLabels(): Array<{ grid: string, position: Position }> {
  const bounds = gridBounds()
  const labels: Array<{ grid: string, position: Position }> = []
  for (let longitude = bounds.longitudeStart; longitude < bounds.longitudeEnd; longitude++) {
    for (let latitude = bounds.latitudeStart; latitude < bounds.latitudeEnd; latitude++) {
      const center: Position = [
        (longitude + 0.5) * GRID_LONGITUDE_STEP,
        (latitude + 0.5) * GRID_LATITUDE_STEP,
      ]
      labels.push({ grid: maidenheadGrid(center), position: projectPoint(center) })
    }
  }
  return labels
}

function gridBounds(
  longitudeStep = GRID_LONGITUDE_STEP,
  latitudeStep = GRID_LATITUDE_STEP,
): { latitudeEnd: number, latitudeStart: number, longitudeEnd: number, longitudeStart: number } {
  const longitudePadding = (EAST - WEST) * PADDING / (MAP_WIDTH - PADDING * 2)
  const latitudePadding = (NORTH - SOUTH) * PADDING / (MAP_HEIGHT - PADDING * 2)
  return {
    latitudeEnd: Math.floor((NORTH + latitudePadding) / latitudeStep),
    latitudeStart: Math.ceil((SOUTH - latitudePadding) / latitudeStep),
    longitudeEnd: Math.floor((EAST + longitudePadding) / longitudeStep),
    longitudeStart: Math.ceil((WEST - longitudePadding) / longitudeStep),
  }
}

function project([longitude, latitude]: Position): string {
  const [x, y] = projectPoint([longitude, latitude])
  return `${x.toFixed(2)},${y.toFixed(2)}`
}

function projectPoint([longitude, latitude]: Position): Position {
  const x = PADDING + (longitude - WEST) / (EAST - WEST) * (MAP_WIDTH - PADDING * 2)
  const y = MAP_HEIGHT - PADDING - (latitude - SOUTH) / (NORTH - SOUTH) * (MAP_HEIGHT - PADDING * 2)
  return [x, y]
}

function maidenheadGrid([longitude, latitude]: Position): string {
  const fieldLongitude = Math.floor((longitude + 180) / 20)
  const fieldLatitude = Math.floor((latitude + 90) / 10)
  const squareLongitude = Math.floor((longitude + 180) % 20 / 2)
  const squareLatitude = Math.floor((latitude + 90) % 10)
  return `${String.fromCharCode(65 + fieldLongitude)}${String.fromCharCode(65 + fieldLatitude)}${squareLongitude}${squareLatitude}`
}
</script>

<template>
  <main class="map-view" aria-label="浙江省县级行政区划地图">
    <svg class="zhejiang-map" :viewBox="`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`" role="img" aria-label="浙江省县级行政区划地图">
      <g class="maidenhead-grid maidenhead-grid-six" aria-label="Maidenhead 六位网格" aria-hidden="true">
        <path v-for="path in sixDigitGridPaths" :key="path" :d="path" />
      </g>
      <g class="maidenhead-grid" aria-label="Maidenhead 四位网格" aria-hidden="true">
        <path v-for="path in gridPaths" :key="path" :d="path" />
      </g>
      <path v-for="county in countyShapes" :key="county.gb" class="county-shape" :class="stateFor(county.gb)" :d="county.path" fill-rule="evenodd">
        <title>{{ county.name }}</title>
      </path>
      <g class="maidenhead-grid-labels" aria-label="Maidenhead 四位网格文字" aria-hidden="true">
        <text v-for="label in gridLabels" :key="label.grid" :x="label.position[0]" :y="label.position[1]">
          {{ label.grid }}
        </text>
      </g>
      <text v-if="!countyShapes.length" class="map-state" :x="MAP_WIDTH / 2" :y="MAP_HEIGHT / 2" text-anchor="middle">
        {{ loadFailed ? '地图数据加载失败' : '正在加载浙江省地图…' }}
      </text>
    </svg>
  </main>
</template>
