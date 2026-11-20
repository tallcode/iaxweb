import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const [callsign = '', input] = process.argv.slice(2)
if (!input || !/^[A-Z0-9][\w-]{0,31}$/i.test(callsign))
  throw new Error('用法：node scripts/pack-coverage.mjs BR5AI /path/to/coverage.geojson')

const source = JSON.parse(await readFile(input, 'utf8'))
if (source?.type !== 'FeatureCollection' || !Array.isArray(source.features) || !source.features.length)
  throw new Error('需要 Meshtastic Site Planner 导出的覆盖 GeoJSON')

const features = source.features.map(({ geometry, properties }) => {
  const { dbm, fill } = properties ?? {}
  if (!Number.isFinite(dbm) || typeof fill !== 'string' || !/^#[0-9a-f]{6}$/i.test(fill))
    throw new Error('每个覆盖档位需要有效的 dbm 和 fill')
  if (geometry?.type !== 'Polygon' && geometry?.type !== 'MultiPolygon')
    throw new Error('覆盖几何必须为 Polygon 或 MultiPolygon')
  const coordinates = geometry.type === 'Polygon'
    ? geometry.coordinates.map(compactRing)
    : geometry.coordinates.map(polygon => polygon.map(compactRing))
  return { type: 'Feature', properties: { dbm, fill }, geometry: { type: geometry.type, coordinates } }
})

const properties = Object.fromEntries(['generator', 'name'].flatMap((key) => {
  const value = source.properties?.[key]
  return typeof value === 'string' ? [[key, value]] : []
}))
const json = Buffer.from(`${JSON.stringify({ type: 'FeatureCollection', properties, features })}\n`)
const gzip = gzipSync(json, { level: 9 })
const directory = fileURLToPath(new URL('../data/coverage/', import.meta.url))
const destination = join(directory, `${callsign.toUpperCase()}.geojson.gz`)
const temporary = `${destination}.${randomUUID()}.tmp`

await mkdir(directory, { recursive: true })
try {
  await writeFile(temporary, gzip)
  await rename(temporary, destination)
}
catch (error) {
  await rm(temporary, { force: true }).catch(() => undefined)
  throw error
}
console.log(`${destination} (${json.length} 字节 GeoJSON，${gzip.length} 字节 gzip)`)

function compactRing(ring) {
  if (!Array.isArray(ring) || ring.length < 4 || ring.some(point =>
    !Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1])
    || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90)) {
    throw new Error('覆盖图层包含无效坐标环')
  }
  if (!samePoint(ring[0], ring.at(-1)))
    throw new Error('覆盖图层包含未闭合的坐标环')

  const factor = 10_000
  const points = []
  for (const [lon, lat] of ring.slice(0, -1)) {
    const point = [Math.round(lon * factor), Math.round(lat * factor)]
    if (points.length && samePoint(point, points.at(-1)))
      continue
    while (points.length >= 2 && isCollinearBetween(points.at(-2), points.at(-1), point))
      points.pop()
    points.push(point)
  }
  if (points.length > 1 && samePoint(points[0], points.at(-1)))
    points.pop()
  points.push(points[0])

  // Keep the original precision if rounding collapses or reverses a ring.
  if (points.length < 4 || twiceArea(points) * twiceArea(ring) <= 0)
    return ring.map(([lon, lat]) => [lon, lat])
  return points.map(([lon, lat]) => [lon / factor, lat / factor])
}

function samePoint(a, b) {
  return a[0] === b[0] && a[1] === b[1]
}

function isCollinearBetween(a, b, c) {
  const dx1 = b[0] - a[0]
  const dy1 = b[1] - a[1]
  const dx2 = c[0] - b[0]
  const dy2 = c[1] - b[1]
  return dx1 * dy2 === dx2 * dy1 && dx1 * dx2 + dy1 * dy2 >= 0
}

function twiceArea(ring) {
  const [x0, y0] = ring[0]
  let area = 0
  for (let i = 1; i < ring.length; i++) {
    const [x1, y1] = ring[i - 1]
    const [x2, y2] = ring[i]
    area += (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
  }
  return area
}
