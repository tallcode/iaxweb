import type { PublicStatusSnapshot, SpotEvent } from '@iaxweb/contracts'
import type { StatusConnectionState } from '../services/status-presentation'
import { NO_CALLSIGN, spotHistorySchema } from '@iaxweb/contracts'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { markSnapshotOffline, StatusStreamClient } from '../services/status-stream'

const MAX_SPOTS = 100
const MAX_CACHED_SPOTS = 1_000

export const useStatusStore = defineStore('status', () => {
  const statusSnapshot = ref<PublicStatusSnapshot>({})
  const hasInitialSnapshot = ref(false)
  const connectionState = ref<StatusConnectionState>('connecting')
  const spotsById = ref(new Map<string, SpotEvent>())
  const spotHistoryReady = ref(false)
  const currentTime = ref(Date.now())
  let streamClient: StatusStreamClient | undefined
  let clockTimerId: ReturnType<typeof setInterval> | undefined
  let needsSpotReconciliation = true
  let historyRequest: AbortController | undefined
  let pendingSpotEvents: SpotEvent[] | undefined

  const aiSpotEnabled = computed(() => Object.values(statusSnapshot.value).some(node => (node.AI_SPOT ?? node.AI) === true))
  const recentSpots = computed(() => {
    void currentTime.value
    const newestByCallsign = new Map<string, SpotEvent>()
    for (const spot of spotsById.value.values()) {
      const current = newestByCallsign.get(spot.callsign)
      if (!current || spot.at >= current.at)
        newestByCallsign.set(spot.callsign, spot)
    }
    return [...newestByCallsign.values()]
      .sort((left, right) => left.at < right.at ? 1 : -1)
      .slice(0, MAX_SPOTS)
  })

  function startStatusStream(): void {
    if (streamClient)
      return
    connectionState.value = 'connecting'
    streamClient = new StatusStreamClient({
      onConnecting: () => connectionState.value = 'reconnecting',
      onExpired: () => statusSnapshot.value = markSnapshotOffline(statusSnapshot.value),
      onInvalidMessage: () => connectionState.value = 'invalid-data',
      onOpen: () => {
        connectionState.value = 'waiting-snapshot'
        needsSpotReconciliation = true
      },
      onSnapshot: (nextSnapshot) => {
        statusSnapshot.value = nextSnapshot
        hasInitialSnapshot.value = true
        connectionState.value = 'ready'
        if (!aiSpotEnabled.value) {
          historyRequest?.abort()
          historyRequest = undefined
          pendingSpotEvents = undefined
          spotsById.value.clear()
          spotHistoryReady.value = false
          needsSpotReconciliation = true
        }
        else if (needsSpotReconciliation) {
          needsSpotReconciliation = false
          void loadSpotHistory()
        }
      },
      onSpot: (spot) => {
        if (hasInitialSnapshot.value && !aiSpotEnabled.value)
          return
        pendingSpotEvents?.push(spot)
        applySpot(spot)
      },
    })
    streamClient.start()
    clockTimerId = setInterval(() => currentTime.value = Date.now(), 15_000)
  }

  function stopStatusStream(): void {
    historyRequest?.abort()
    historyRequest = undefined
    pendingSpotEvents = undefined
    needsSpotReconciliation = true
    streamClient?.stop()
    streamClient = undefined
    if (clockTimerId)
      clearInterval(clockTimerId)
    clockTimerId = undefined
  }

  function applySpot(spot: SpotEvent): void {
    if (spot.callsign === NO_CALLSIGN) {
      spotsById.value.delete(spot.id)
    }
    else {
      const previous = spotsById.value.get(spot.id)
      if (!previous || spot.at >= previous.at) {
        spotsById.value.set(spot.id, spot)
        if (spotsById.value.size > MAX_CACHED_SPOTS) {
          let oldest: SpotEvent | undefined
          for (const cached of spotsById.value.values()) {
            if (!oldest || cached.at < oldest.at)
              oldest = cached
          }
          if (oldest)
            spotsById.value.delete(oldest.id)
        }
      }
    }
  }

  async function loadSpotHistory(): Promise<void> {
    historyRequest?.abort()
    const request = new AbortController()
    const events: SpotEvent[] = []
    historyRequest = request
    pendingSpotEvents = events
    try {
      const response = await fetch('/api/spots', { signal: request.signal })
      if (!response.ok)
        throw new Error('Spot history is unavailable')
      const history = spotHistorySchema.parse(await response.json())
      if (request.signal.aborted || historyRequest !== request)
        return
      // Replace the stale cache, then replay events received during the request.
      // This includes N0CALL removals, so a late response cannot resurrect them.
      spotsById.value = new Map()
      history.forEach(applySpot)
      events.forEach(applySpot)
    }
    catch {
      if (!request.signal.aborted)
        needsSpotReconciliation = true
    }
    finally {
      if (historyRequest === request) {
        historyRequest = undefined
        pendingSpotEvents = undefined
        spotHistoryReady.value = true
      }
    }
  }

  return {
    aiSpotEnabled,
    connectionState,
    hasInitialSnapshot,
    recentSpots,
    spotHistoryReady,
    startStatusStream,
    statusSnapshot,
    stopStatusStream,
  }
})
