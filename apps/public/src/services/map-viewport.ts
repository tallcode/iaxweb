export interface MapViewport {
  x: number
  y: number
  zoom: number
}

export const MAP_MAX_ZOOM = 10
export const MAP_MIN_ZOOM = 1
const RECENTER_TAIL_ZOOM = 1.5

export function mapViewBox(
  viewport: MapViewport,
  mapWidth: number,
  mapHeight: number,
  offsetX = 0,
  offsetY = 0,
): string {
  if (![viewport.x, viewport.y, viewport.zoom, mapWidth, mapHeight, offsetX, offsetY].every(Number.isFinite) || viewport.zoom <= 0)
    return '0 0 1 1'
  return `${offsetX + viewport.x} ${offsetY + viewport.y} ${mapWidth / viewport.zoom} ${mapHeight / viewport.zoom}`
}

export function panMapViewport(
  viewport: MapViewport,
  deltaX: number,
  deltaY: number,
  mapWidth: number,
  mapHeight: number,
): MapViewport {
  if (![viewport.x, viewport.y, viewport.zoom, deltaX, deltaY, mapWidth, mapHeight].every(Number.isFinite))
    return viewport
  const width = mapWidth / viewport.zoom
  const height = mapHeight / viewport.zoom
  return {
    x: clamp(viewport.x + deltaX, 0, mapWidth - width),
    y: clamp(viewport.y + deltaY, 0, mapHeight - height),
    zoom: viewport.zoom,
  }
}

export function zoomMapViewport(
  viewport: MapViewport,
  anchorX: number,
  anchorY: number,
  factor: number,
  mapWidth: number,
  mapHeight: number,
): MapViewport {
  if (![viewport.x, viewport.y, viewport.zoom, anchorX, anchorY, factor, mapWidth, mapHeight].every(Number.isFinite))
    return viewport
  const zoom = clamp(viewport.zoom * factor, MAP_MIN_ZOOM, MAP_MAX_ZOOM)
  if (zoom === viewport.zoom)
    return viewport

  const currentWidth = mapWidth / viewport.zoom
  const currentHeight = mapHeight / viewport.zoom
  const anchorRatioX = clamp((anchorX - viewport.x) / currentWidth, 0, 1)
  const anchorRatioY = clamp((anchorY - viewport.y) / currentHeight, 0, 1)
  const width = mapWidth / zoom
  const height = mapHeight / zoom

  return {
    x: clamp(anchorX - anchorRatioX * width, 0, mapWidth - width),
    y: clamp(anchorY - anchorRatioY * height, 0, mapHeight - height),
    zoom,
  }
}

export function zoomMapViewportTowardCenter(
  viewport: MapViewport,
  factor: number,
  mapWidth: number,
  mapHeight: number,
): MapViewport {
  if (![viewport.x, viewport.y, viewport.zoom, factor, mapWidth, mapHeight].every(Number.isFinite))
    return viewport
  const zoom = clamp(viewport.zoom * factor, MAP_MIN_ZOOM, MAP_MAX_ZOOM)
  if (zoom === viewport.zoom)
    return viewport
  const width = mapWidth / zoom
  const height = mapHeight / zoom
  const currentCenterX = viewport.x + mapWidth / viewport.zoom / 2
  const currentCenterY = viewport.y + mapHeight / viewport.zoom / 2
  const remainingOffsetRatio = centerOffsetWeight(zoom) / centerOffsetWeight(viewport.zoom)
  const centerX = mapWidth / 2 + (currentCenterX - mapWidth / 2) * remainingOffsetRatio
  const centerY = mapHeight / 2 + (currentCenterY - mapHeight / 2) * remainingOffsetRatio
  return {
    x: clamp(centerX - width / 2, 0, mapWidth - width),
    y: clamp(centerY - height / 2, 0, mapHeight - height),
    zoom,
  }
}

function centerOffsetWeight(zoom: number): number {
  if (zoom >= RECENTER_TAIL_ZOOM)
    return zoom
  return RECENTER_TAIL_ZOOM * (zoom - MAP_MIN_ZOOM) / (RECENTER_TAIL_ZOOM - MAP_MIN_ZOOM)
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}
