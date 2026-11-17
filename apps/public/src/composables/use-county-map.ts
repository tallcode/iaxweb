import type { CountyShape, FeatureCollection } from '../services/map-geometry'
import { ref } from 'vue'
import { shapesFrom } from '../services/map-geometry'

export function useCountyMap(zhejiangUrl: string) {
  const STORAGE_KEY = `zhejiang-map:${zhejiangUrl}`
  const countyShapes = ref<CountyShape[]>([])
  const mapLoadState = ref<'failed' | 'loading' | 'ready'>('loading')
  async function load(): Promise<void> {
    try {
      const cached = loadFromStorage()
      const data = cached ?? await loadFromNetwork()
      countyShapes.value = shapesFrom(data)
      mapLoadState.value = 'ready'
      if (!cached)
        saveToStorage(data)
    }
    catch { mapLoadState.value = 'failed' }
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

  return { countyShapes, mapLoadState, load }
}
