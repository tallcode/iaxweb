import type { PublicStatusSnapshot, SpotEvent } from '@iaxweb/contracts'
import type { StatusConnectionState } from '../services/status-presentation'
import { NO_CALLSIGN } from '@iaxweb/contracts'
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
      onOpen: () => connectionState.value = 'waiting-snapshot',
      onSnapshot: (nextSnapshot) => {
        statusSnapshot.value = nextSnapshot
        hasInitialSnapshot.value = true
        connectionState.value = 'ready'
        if (!aiSpotEnabled.value) {
          spotsById.value.clear()
          spotHistoryReady.value = false
        }
      },
      onSpot: (spot) => {
        if (hasInitialSnapshot.value && !aiSpotEnabled.value)
          return
        applySpot(spot)
      },
      onSpotHistory: (spots) => {
        spotsById.value = new Map()
        spots.forEach(applySpot)
        spotHistoryReady.value = true
      },
    })
    streamClient.start()
    clockTimerId = setInterval(() => currentTime.value = Date.now(), 15_000)
  }

  function stopStatusStream(): void {
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
