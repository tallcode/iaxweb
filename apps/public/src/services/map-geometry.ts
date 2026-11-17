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
  return data.features.map(feature => ({
    gb: feature.properties.gb,
    name: feature.properties.name ?? '未命名区域',
    path: geometryPath(feature.geometry),
  }))
}

export function projectPoint([longitude, latitude]: Position): Position {
  const x = PADDING + (longitude - WEST) / (EAST - WEST) * (MAP_WIDTH - PADDING * 2)
  const y = MAP_HEIGHT - PADDING - (latitude - SOUTH) / (NORTH - SOUTH) * (MAP_HEIGHT - PADDING * 2)
  return [x, y]
}
function geometryPath(geometry: Geometry): string {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates as Polygon] : geometry.coordinates as Polygon[]
  return polygons.flatMap(polygon => polygon.map(ringPath)).join('')
}

function ringPath(ring: Position[]): string {
  return `${ring.map((position, index) => `${index === 0 ? 'M' : 'L'}${project(position)}`).join('')}Z`
}

function project([longitude, latitude]: Position): string {
  const [x, y] = projectPoint([longitude, latitude])
  return `${x.toFixed(2)},${y.toFixed(2)}`
}
