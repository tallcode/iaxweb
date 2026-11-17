import type { MapCanvasSize, Position } from './map-geometry'
import { EAST, GRID_INDEX_EPSILON, GRID_LATITUDE_STEP, GRID_LONGITUDE_STEP, MAP_HEIGHT, MAP_WIDTH, NORTH, projectPoint, SIX_DIGIT_LATITUDE_STEP, SIX_DIGIT_LONGITUDE_STEP, SOUTH, WEST } from './map-geometry'

export interface MapGridContext { size: MapCanvasSize, offset: { x: number, y: number }, viewport: { x: number, y: number, zoom: number } }

export function createGridPaths(context: MapGridContext, longitudeStep = GRID_LONGITUDE_STEP, latitudeStep = GRID_LATITUDE_STEP): string[] {
  const { offset, size } = context
  const paths: string[] = []
  const bounds = geographicBounds(offset.x, offset.y, size.width, size.height)
  const longitudeStart = Math.ceil(bounds.west / longitudeStep - GRID_INDEX_EPSILON)
  const longitudeEnd = Math.floor(bounds.east / longitudeStep + GRID_INDEX_EPSILON)
  const latitudeStart = Math.ceil(bounds.south / latitudeStep - GRID_INDEX_EPSILON)
  const latitudeEnd = Math.floor(bounds.north / latitudeStep + GRID_INDEX_EPSILON)
  for (let index = longitudeStart; index <= longitudeEnd; index++) {
    const x = project([index * longitudeStep, SOUTH]).split(',')[0]
    paths.push(`M${x},${offset.y}L${x},${offset.y + size.height}`)
  }
  for (let index = latitudeStart; index <= latitudeEnd; index++) {
    const y = project([WEST, index * latitudeStep]).split(',')[1]
    paths.push(`M${offset.x},${y}L${offset.x + size.width},${y}`)
  }
  return paths
}

export function createGridLabels(context: MapGridContext): Array<{ grid: string, position: Position }> {
  const { offset, size } = context
  const labels: Array<{ grid: string, position: Position }> = []
  const bounds = geographicBounds(offset.x, offset.y, size.width, size.height)
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

export function createVisibleSixDigitGridLabels(context: MapGridContext): Array<{ grid: string, position: Position }> {
  const { offset, size, viewport } = context
  const width = size.width / viewport.zoom
  const height = size.height / viewport.zoom
  const bounds = geographicBounds(
    offset.x + viewport.x,
    offset.y + viewport.y,
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

function project([longitude, latitude]: Position): string {
  const [x, y] = projectPoint([longitude, latitude])
  return `${x.toFixed(2)},${y.toFixed(2)}`
}
