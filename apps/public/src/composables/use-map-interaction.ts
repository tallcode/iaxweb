import type { MapCanvasSize } from '../services/map-geometry'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { MAP_HEIGHT, MAP_WIDTH } from '../services/map-geometry'
import { mapViewBox, panMapViewport, zoomMapViewport, zoomMapViewportTowardCenter } from '../services/map-viewport'

interface DragState { clientX: number, clientY: number, pointerId: number }
const WHEEL_ZOOM_SENSITIVITY = 0.00225

export function useMapInteraction() {
  const canvasSize = ref<MapCanvasSize>({ height: MAP_HEIGHT, width: MAP_WIDTH })
  const renderedSize = ref<MapCanvasSize>({ height: MAP_HEIGHT, width: MAP_WIDTH })
  const isDragging = ref(false)
  const mapElement = ref<SVGSVGElement | null>(null)
  const viewport = ref({ x: 0, y: 0, zoom: 1 })
  const canvasOffset = computed(() => offsetForCanvas(canvasSize.value))
  const viewportViewBox = computed(() => mapViewBox(viewport.value, canvasSize.value.width, canvasSize.value.height, canvasOffset.value.x, canvasOffset.value.y))
  let dragState: DragState | undefined
  let resizeObserver: ResizeObserver | undefined
  onMounted(() => {
    const element = mapElement.value
    if (!element)
      return
    updateCanvasSize(element.clientWidth, element.clientHeight)
    resizeObserver = new ResizeObserver(([entry]) => {
      if (entry)
        updateCanvasSize(entry.contentRect.width, entry.contentRect.height)
    })
    resizeObserver.observe(element)
  })
  onBeforeUnmount(() => resizeObserver?.disconnect())
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
  }

  function handlePointerDown(event: PointerEvent): void {
    if (!event.isPrimary || event.button !== 0 || viewport.value.zoom === 1)
      return
    const element = mapElement.value
    if (!element)
      return
    event.preventDefault()
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

  return { canvasSize, renderedSize, isDragging, mapElement, viewport, canvasOffset, viewportViewBox, handleMapWheel, handlePointerDown, handlePointerMove, handlePointerEnd }
}
