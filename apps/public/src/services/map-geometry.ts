export type Position = [number, number]
export type Polygon = Position[][]
export interface Geometry {
  coordinates: Polygon | Polygon[]
  type: 'Polygon' | 'MultiPolygon'
}
export interface CountyFeature {
  geometry: Geometry
  properties: { gb: string, name?: string }
}
export interface FeatureCollection {
  features: CountyFeature[]
}
export interface CountyShape {
  center: Position | undefined
  gb: string
  name: string
  path: string
}
export interface MapCanvasSize { height: number, width: number }
export const GRID_LONGITUDE_STEP = 2
export const GRID_LATITUDE_STEP = 1
export const SIX_DIGIT_LONGITUDE_STEP = 1 / 12
export const SIX_DIGIT_LATITUDE_STEP = 1 / 24
export const MAP_HEIGHT = 840
export const MAP_WIDTH = MAP_HEIGHT * 8 / 5
export const PADDING = 0
export const WEST = 116
export const EAST = 124
export const SOUTH = 27
export const NORTH = 32
export const GRID_INDEX_EPSILON = 1e-9
export const SIX_DIGIT_LABEL_MIN_HEIGHT_PX = 24
export const SIX_DIGIT_CELL_HEIGHT = MAP_HEIGHT * SIX_DIGIT_LATITUDE_STEP / (NORTH - SOUTH)

export function shapesFrom(data: FeatureCollection): CountyShape[] {
  return data.features.map(({ geometry, properties }) => {
    const center = countyCenter(geometry)
    return {
      center: center && projectPoint(center),
      gb: properties.gb,
      name: properties.name ?? '未命名区域',
      path: geometryPath(geometry),
    }
  })
}

export function projectPoint([longitude, latitude]: Position): Position {
  const x = PADDING + (longitude - WEST) / (EAST - WEST) * (MAP_WIDTH - PADDING * 2)
  const y = MAP_HEIGHT - PADDING - (latitude - SOUTH) / (NORTH - SOUTH) * (MAP_HEIGHT - PADDING * 2)
  return [x, y]
}
export function geometryPath(geometry: Geometry): string {
  return polygonsOf(geometry).flatMap(polygon => polygon.map(ringPath)).join('')
}

function polygonsOf(geometry: Geometry): Polygon[] {
  return geometry.type === 'Polygon' ? [geometry.coordinates as Polygon] : geometry.coordinates as Polygon[]
}

function countyCenter(geometry: Geometry): Position | undefined {
  let largest: { area: number, center: Position, polygon: Polygon } | undefined
  for (const polygon of polygonsOf(geometry)) {
    const outerRing = polygon[0]
    if (!outerRing)
      continue
    const centroid = ringCentroid(outerRing)
    if (centroid && (!largest || centroid.area > largest.area))
      largest = { ...centroid, polygon }
  }
  if (!largest)
    return undefined

  const [longitude, centroidLatitude] = largest.center
  let nextLatitude = Infinity
  let onVertex = false
  for (const ring of largest.polygon) {
    for (const [, latitude] of ring) {
      if (latitude === centroidLatitude)
        onVertex = true
      if (latitude > centroidLatitude)
        nextLatitude = Math.min(nextLatitude, latitude)
    }
  }
  // A scanline between vertex latitudes also avoids horizontal edges.
  const latitude = onVertex ? (centroidLatitude + nextLatitude) / 2 : centroidLatitude
  const crossings: number[] = []
  for (const ring of largest.polygon) {
    for (let i = 1; i < ring.length; i++) {
      const [x1, y1] = ring[i - 1]!
      const [x2, y2] = ring[i]!
      if ((y1 > latitude) !== (y2 > latitude))
        crossings.push(x1 + (latitude - y1) * (x2 - x1) / (y2 - y1))
    }
  }
  crossings.sort((a, b) => a - b)
  let interior: Position | undefined
  let widest = 0
  for (let i = 1; i < crossings.length; i += 2) {
    const left = crossings[i - 1]!
    const right = crossings[i]!
    if (left < longitude && longitude < right)
      return [longitude, latitude]
    if (right - left > widest) {
      widest = right - left
      interior = [(left + right) / 2, latitude]
    }
  }
  return interior
}

function ringCentroid(ring: Position[]): { area: number, center: Position } | undefined {
  if (ring.length < 4)
    return undefined
  const [originX, originY] = ring[0]!
  let twiceArea = 0
  let xMoment = 0
  let yMoment = 0
  for (let i = 1; i < ring.length; i++) {
    const [x1, y1] = ring[i - 1]!
    const [x2, y2] = ring[i]!
    // Translate before multiplying to keep small polygons numerically stable.
    const cross = (x1 - originX) * (y2 - originY) - (x2 - originX) * (y1 - originY)
    twiceArea += cross
    xMoment += (x1 + x2 - 2 * originX) * cross
    yMoment += (y1 + y2 - 2 * originY) * cross
  }
  if (twiceArea === 0)
    return undefined
  return {
    area: Math.abs(twiceArea) / 2,
    center: [originX + xMoment / (3 * twiceArea), originY + yMoment / (3 * twiceArea)],
  }
}

function ringPath(ring: Position[]): string {
  return `${ring.map((position, index) => `${index === 0 ? 'M' : 'L'}${project(position)}`).join('')}Z`
}

function project([longitude, latitude]: Position): string {
  const [x, y] = projectPoint([longitude, latitude])
  return `${x.toFixed(2)},${y.toFixed(2)}`
}
