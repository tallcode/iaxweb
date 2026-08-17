<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import zhejiangUrl from '../../assets/zhejiang.geojson?url'
import { countyState, mapStates } from '../services/map-county-status'
import { mapViewBox, panMapViewport, zoomMapViewport, zoomMapViewportTowardCenter } from '../services/map-viewport'
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
interface DragState {
  clientX: number
  clientY: number
  pointerId: number
}
interface MapCanvasSize {
  height: number
  width: number
}
interface DebugCenterPoint {
  id: number
  x: number
  y: number
}
const emit = defineEmits<{ pageReady: [] }>()

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
const WHEEL_ZOOM_SENSITIVITY = 0.00225
const GRID_INDEX_EPSILON = 1e-9
const SIX_DIGIT_LABEL_MIN_HEIGHT_PX = 24
const SIX_DIGIT_CELL_HEIGHT = MAP_HEIGHT * SIX_DIGIT_LATITUDE_STEP / (NORTH - SOUTH)
// Keep the center trail available for future zoom diagnostics without showing it normally.
const SHOW_MAP_CENTER_DEBUG = false

const countyShapes = ref<CountyShape[]>([])
const canvasSize = ref<MapCanvasSize>({ height: MAP_HEIGHT, width: MAP_WIDTH })
const debugCenterPoints = ref<DebugCenterPoint[]>([])
const isDragging = ref(false)
const mapElement = ref<SVGSVGElement | null>(null)
const mapLoadState = ref<'failed' | 'loading' | 'ready'>('loading')
const renderedSize = ref<MapCanvasSize>({ height: MAP_HEIGHT, width: MAP_WIDTH })
const viewport = ref({ x: 0, y: 0, zoom: 1 })
const { statusSnapshot } = storeToRefs(useStatusStore())
const canvasOffset = computed(() => offsetForCanvas(canvasSize.value))
const states = computed(() => mapStates(statusSnapshot.value))
const viewportViewBox = computed(() => mapViewBox(
  viewport.value,
  canvasSize.value.width,
  canvasSize.value.height,
  canvasOffset.value.x,
  canvasOffset.value.y,
))
const onlineCountyShapes = computed(() => countyShapes.value.filter(county => stateFor(county.gb) === 'online'))
const transmittingCountyShapes = computed(() => countyShapes.value.filter(county => stateFor(county.gb).startsWith('tx-')))
const showSixDigitGridLabels = computed(() => (
  SIX_DIGIT_CELL_HEIGHT * renderedSize.value.height / (canvasSize.value.height / viewport.value.zoom)
) > SIX_DIGIT_LABEL_MIN_HEIGHT_PX)
const visibleSixDigitGridLabels = computed(() => showSixDigitGridLabels.value
  ? createVisibleSixDigitGridLabels()
  : [])
const sixDigitGridPaths = computed(() => createGridPaths(SIX_DIGIT_LONGITUDE_STEP, SIX_DIGIT_LATITUDE_STEP))
const gridPaths = computed(() => createGridPaths())
const gridLabels = computed(() => createGridLabels())
let dragState: DragState | undefined
let debugCenterPointId = 0
let debugFrame: number | undefined
let resizeObserver: ResizeObserver | undefined

onMounted(async () => {
  const element = mapElement.value
  if (element) {
    updateCanvasSize(element.clientWidth, element.clientHeight)
    resizeObserver = new ResizeObserver(([entry]) => {
      if (entry)
        updateCanvasSize(entry.contentRect.width, entry.contentRect.height)
    })
    resizeObserver.observe(element)
  }
  try {
    const cached = loadFromStorage()
    const data = cached ?? await loadFromNetwork()
    countyShapes.value = shapesFrom(data)
    mapLoadState.value = 'ready'
    if (!cached)
      saveToStorage(data)
  }
  catch {
    mapLoadState.value = 'failed'
  }
  finally {
    emit('pageReady')
  }
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  if (debugFrame !== undefined)
    cancelAnimationFrame(debugFrame)
})

function stateFor(gb: string): string {
  return countyState(gb, states.value)
}

function handleMapWheel(event: WheelEvent): void {
  if (event.ctrlKey || event.metaKey)
    return
  const element = mapElement.value
  const screenMatrix = element?.getScreenCTM()
  if (!element || !screenMatrix)
    return
  event.preventDefault()
  const point = element.createSVGPoint()
  point.x = event.clientX
  point.y = event.clientY
  const pointerMapPoint = point.matrixTransform(screenMatrix.inverse())
  if (!Number.isFinite(pointerMapPoint.x) || !Number.isFinite(pointerMapPoint.y))
    return
  const pointerAnchor = {
    x: pointerMapPoint.x - canvasOffset.value.x,
    y: pointerMapPoint.y - canvasOffset.value.y,
  }
  const delta = normalizedWheelDelta(event, element.clientHeight)
  const factor = Math.exp(-delta * WHEEL_ZOOM_SENSITIVITY)
  viewport.value = factor < 1
    ? zoomMapViewportTowardCenter(viewport.value, factor, canvasSize.value.width, canvasSize.value.height)
    : zoomMapViewport(viewport.value, pointerAnchor.x, pointerAnchor.y, factor, canvasSize.value.width, canvasSize.value.height)
  if (SHOW_MAP_CENTER_DEBUG && factor < 1)
    scheduleDebugCenterPoint()
  else if (SHOW_MAP_CENTER_DEBUG)
    clearDebugCenterPoints()
}

function handlePointerDown(event: PointerEvent): void {
  if (!event.isPrimary || event.button !== 0 || viewport.value.zoom === 1)
    return
  const element = mapElement.value
  if (!element)
    return
  event.preventDefault()
  if (SHOW_MAP_CENTER_DEBUG)
    clearDebugCenterPoints()
  element.setPointerCapture(event.pointerId)
  dragState = { clientX: event.clientX, clientY: event.clientY, pointerId: event.pointerId }
  isDragging.value = true
}

function handlePointerMove(event: PointerEvent): void {
  const previous = dragState
  const element = mapElement.value
  const screenMatrix = element?.getScreenCTM()
  if (!previous || previous.pointerId !== event.pointerId || !element || !screenMatrix)
    return
  event.preventDefault()
  const inverseMatrix = screenMatrix.inverse()
  const previousPoint = element.createSVGPoint()
  previousPoint.x = previous.clientX
  previousPoint.y = previous.clientY
  const currentPoint = element.createSVGPoint()
  currentPoint.x = event.clientX
  currentPoint.y = event.clientY
  const previousMapPoint = previousPoint.matrixTransform(inverseMatrix)
  const currentMapPoint = currentPoint.matrixTransform(inverseMatrix)
  if (![previousMapPoint.x, previousMapPoint.y, currentMapPoint.x, currentMapPoint.y].every(Number.isFinite))
    return
  viewport.value = panMapViewport(
    viewport.value,
    previousMapPoint.x - currentMapPoint.x,
    previousMapPoint.y - currentMapPoint.y,
    canvasSize.value.width,
    canvasSize.value.height,
  )
  dragState = { clientX: event.clientX, clientY: event.clientY, pointerId: event.pointerId }
}

function handlePointerEnd(event: PointerEvent): void {
  if (dragState?.pointerId !== event.pointerId)
    return
  dragState = undefined
  isDragging.value = false
  if (mapElement.value?.hasPointerCapture(event.pointerId))
    mapElement.value.releasePointerCapture(event.pointerId)
}

function normalizedWheelDelta(event: WheelEvent, pageHeight: number): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE)
    return event.deltaY * 16
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE)
    return event.deltaY * pageHeight
  return event.deltaY
}

function scheduleDebugCenterPoint(): void {
  if (debugFrame !== undefined)
    return
  debugFrame = requestAnimationFrame(() => {
    debugFrame = undefined
    const element = mapElement.value
    const container = element?.parentElement
    const screenMatrix = element?.getScreenCTM()
    if (!element || !container || !screenMatrix)
      return
    const center = element.createSVGPoint()
    center.x = canvasOffset.value.x + canvasSize.value.width / 2
    center.y = canvasOffset.value.y + canvasSize.value.height / 2
    const screenCenter = center.matrixTransform(screenMatrix)
    const containerRect = container.getBoundingClientRect()
    const x = screenCenter.x - containerRect.left
    const y = screenCenter.y - containerRect.top
    if (!Number.isFinite(x) || !Number.isFinite(y))
      return
    debugCenterPoints.value.push({ id: debugCenterPointId++, x, y })
    if (debugCenterPoints.value.length > 600)
      debugCenterPoints.value.shift()
  })
}

function clearDebugCenterPoints(): void {
  debugCenterPoints.value = []
}

function updateCanvasSize(renderedWidth: number, renderedHeight: number): void {
  if (!Number.isFinite(renderedWidth) || !Number.isFinite(renderedHeight) || renderedWidth <= 0 || renderedHeight <= 0)
    return
  renderedSize.value = { height: renderedHeight, width: renderedWidth }
  if (![viewport.value.x, viewport.value.y, viewport.value.zoom].every(Number.isFinite))
    viewport.value = { x: 0, y: 0, zoom: 1 }
  const previousSize = canvasSize.value
  const previousOffset = offsetForCanvas(previousSize)
  const centerX = previousOffset.x + viewport.value.x + previousSize.width / viewport.value.zoom / 2
  const centerY = previousOffset.y + viewport.value.y + previousSize.height / viewport.value.zoom / 2
  const aspectRatio = renderedWidth / renderedHeight
  const nextSize = aspectRatio >= MAP_WIDTH / MAP_HEIGHT
    ? { height: MAP_HEIGHT, width: MAP_HEIGHT * aspectRatio }
    : { height: MAP_WIDTH / aspectRatio, width: MAP_WIDTH }
  const nextOffset = offsetForCanvas(nextSize)
  canvasSize.value = nextSize
  viewport.value = panMapViewport({
    x: centerX - nextOffset.x - nextSize.width / viewport.value.zoom / 2,
    y: centerY - nextOffset.y - nextSize.height / viewport.value.zoom / 2,
    zoom: viewport.value.zoom,
  }, 0, 0, nextSize.width, nextSize.height)
}

function offsetForCanvas(size: MapCanvasSize): { x: number, y: number } {
  return { x: (MAP_WIDTH - size.width) / 2, y: (MAP_HEIGHT - size.height) / 2 }
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
  const offset = canvasOffset.value
  const bounds = geographicBounds(offset.x, offset.y, canvasSize.value.width, canvasSize.value.height)
  const longitudeStart = Math.ceil(bounds.west / longitudeStep - GRID_INDEX_EPSILON)
  const longitudeEnd = Math.floor(bounds.east / longitudeStep + GRID_INDEX_EPSILON)
  const latitudeStart = Math.ceil(bounds.south / latitudeStep - GRID_INDEX_EPSILON)
  const latitudeEnd = Math.floor(bounds.north / latitudeStep + GRID_INDEX_EPSILON)
  for (let index = longitudeStart; index <= longitudeEnd; index++) {
    const x = project([index * longitudeStep, SOUTH]).split(',')[0]
    paths.push(`M${x},${offset.y}L${x},${offset.y + canvasSize.value.height}`)
  }
  for (let index = latitudeStart; index <= latitudeEnd; index++) {
    const y = project([WEST, index * latitudeStep]).split(',')[1]
    paths.push(`M${offset.x},${y}L${offset.x + canvasSize.value.width},${y}`)
  }
  return paths
}

function createGridLabels(): Array<{ grid: string, position: Position }> {
  const labels: Array<{ grid: string, position: Position }> = []
  const offset = canvasOffset.value
  const bounds = geographicBounds(offset.x, offset.y, canvasSize.value.width, canvasSize.value.height)
  const range = gridCellRange(bounds, GRID_LONGITUDE_STEP, GRID_LATITUDE_STEP)
  for (let longitude = range.longitudeStart; longitude <= range.longitudeEnd; longitude++) {
    for (let latitude = range.latitudeStart; latitude <= range.latitudeEnd; latitude++) {
      const center: Position = [
        (longitude + 0.5) * GRID_LONGITUDE_STEP,
        (latitude + 0.5) * GRID_LATITUDE_STEP,
      ]
      labels.push({ grid: maidenheadGrid(center), position: projectPoint(center) })
    }
  }
  return labels
}

function createVisibleSixDigitGridLabels(): Array<{ grid: string, position: Position }> {
  const width = canvasSize.value.width / viewport.value.zoom
  const height = canvasSize.value.height / viewport.value.zoom
  const bounds = geographicBounds(
    canvasOffset.value.x + viewport.value.x,
    canvasOffset.value.y + viewport.value.y,
    width,
    height,
  )
  const range = gridCellRange(bounds, SIX_DIGIT_LONGITUDE_STEP, SIX_DIGIT_LATITUDE_STEP)
  const labels: Array<{ grid: string, position: Position }> = []
  for (let longitude = range.longitudeStart; longitude <= range.longitudeEnd; longitude++) {
    for (let latitude = range.latitudeStart; latitude <= range.latitudeEnd; latitude++) {
      const center: Position = [
        (longitude + 0.5) * SIX_DIGIT_LONGITUDE_STEP,
        (latitude + 0.5) * SIX_DIGIT_LATITUDE_STEP,
      ]
      labels.push({ grid: maidenheadGrid(center, 6), position: projectPoint(center) })
    }
  }
  return labels
}

function geographicBounds(x: number, y: number, width: number, height: number): { east: number, north: number, south: number, west: number } {
  return {
    east: WEST + (x + width) / MAP_WIDTH * (EAST - WEST),
    north: NORTH - y / MAP_HEIGHT * (NORTH - SOUTH),
    south: NORTH - (y + height) / MAP_HEIGHT * (NORTH - SOUTH),
    west: WEST + x / MAP_WIDTH * (EAST - WEST),
  }
}

function gridCellRange(
  bounds: { east: number, north: number, south: number, west: number },
  longitudeStep: number,
  latitudeStep: number,
): { latitudeEnd: number, latitudeStart: number, longitudeEnd: number, longitudeStart: number } {
  return {
    latitudeEnd: Math.ceil(bounds.north / latitudeStep - GRID_INDEX_EPSILON) - 1,
    latitudeStart: Math.floor(bounds.south / latitudeStep + GRID_INDEX_EPSILON),
    longitudeEnd: Math.ceil(bounds.east / longitudeStep - GRID_INDEX_EPSILON) - 1,
    longitudeStart: Math.floor(bounds.west / longitudeStep + GRID_INDEX_EPSILON),
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

function maidenheadGrid([longitude, latitude]: Position, precision: 4 | 6 = 4): string {
  const fieldLongitude = Math.floor((longitude + 180) / 20)
  const fieldLatitude = Math.floor((latitude + 90) / 10)
  const squareLongitude = Math.floor((longitude + 180) % 20 / 2)
  const squareLatitude = Math.floor((latitude + 90) % 10)
  const fourDigitGrid = `${String.fromCharCode(65 + fieldLongitude)}${String.fromCharCode(65 + fieldLatitude)}${squareLongitude}${squareLatitude}`
  if (precision === 4)
    return fourDigitGrid
  const subsquareLongitude = Math.floor((longitude + 180) % 2 * 12)
  const subsquareLatitude = Math.floor((latitude + 90) % 1 * 24)
  return `${fourDigitGrid}${String.fromCharCode(65 + subsquareLongitude)}${String.fromCharCode(65 + subsquareLatitude)}`
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
    <div v-if="SHOW_MAP_CENTER_DEBUG" class="map-center-debug" aria-hidden="true">
      <i
        v-for="point in debugCenterPoints"
        :key="point.id"
        class="map-center-debug-point"
        :style="{ left: `${point.x}px`, top: `${point.y}px` }"
      />
    </div>
  </main>
</template>
