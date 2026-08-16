import type { PublicStatusSnapshot, SpotEvent } from '@iaxweb/contracts'
import type { RepeaterSummary, StatusConnectionState } from '../services/status-presentation'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { markSnapshotOffline, StatusStreamClient } from '../services/status-stream'

const NO_CALLSIGN = 'N0CALL'
const MAX_SPOTS = 100

export const useStatusStore = defineStore('status', () => {
  const statusSnapshot = ref<PublicStatusSnapshot>({})
  const hasInitialSnapshot = ref(false)
  const connectionState = ref<StatusConnectionState>('connecting')
  const spotsById = ref(new Map<string, SpotEvent>())
  const currentTime = ref(Date.now())
  let streamClient: StatusStreamClient | undefined
  let clockTimerId: ReturnType<typeof setInterval> | undefined
  let hasLoadedSpotHistory = false

  const aiSpotEnabled = computed(() => Object.values(statusSnapshot.value).some(node => node.AI === true))
  const repeaterSummary = computed<RepeaterSummary>(() => {
    const repeaters = Object.values(statusSnapshot.value).filter(node => node.TYPE === 'REPEATER')
    return {
      online: repeaters.filter(node => node.ONLINE === true).length,
      total: repeaters.length,
      transmitting: repeaters.filter(node => node.TX_SOURCE).length,
    }
  })
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
        if (aiSpotEnabled.value && !hasLoadedSpotHistory) {
          hasLoadedSpotHistory = true
          void loadSpotHistory()
        }
      },
      onSpot: applySpot,
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
      if (!previous || spot.at >= previous.at)
        spotsById.value.set(spot.id, spot)
    }
  }

  async function loadSpotHistory(): Promise<void> {
    try {
      const response = await fetch('/api/spots')
      if (!response.ok)
        return
      const history = await response.json() as SpotEvent[]
      history.forEach(applySpot)
    }
    catch {
      // Live status remains usable when optional history is unavailable.
    }
  }

  return {
    aiSpotEnabled,
    connectionState,
    hasInitialSnapshot,
    recentSpots,
    repeaterSummary,
    startStatusStream,
    statusSnapshot,
    stopStatusStream,
  }
})
