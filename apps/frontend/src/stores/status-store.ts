import type { PublicStatusSnapshot, SpotEvent } from '@iaxweb/contracts'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { markSnapshotOffline, StatusStreamClient } from '../services/status-stream'

const NO_CALLSIGN = 'N0CALL'
const MAX_SPOTS = 100

export const useStatusStore = defineStore('status', () => {
  const statusSnapshot = ref<PublicStatusSnapshot>({})
  const statusMessage = ref('正在连接状态服务…')
  const spotsById = ref(new Map<string, SpotEvent>())
  const currentTime = ref(Date.now())
  let streamClient: StatusStreamClient | undefined
  let clockTimerId: ReturnType<typeof setInterval> | undefined
  let hasLoadedSpotHistory = false

  const aiSpotEnabled = computed(() => Object.values(statusSnapshot.value).some(node => node.AI === true))
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
    streamClient = new StatusStreamClient({
      onConnecting: () => statusMessage.value = '状态服务已断开，正在重连…',
      onExpired: () => statusSnapshot.value = markSnapshotOffline(statusSnapshot.value),
      onInvalidMessage: () => statusMessage.value = '收到无法解析的状态数据',
      onOpen: () => statusMessage.value = '已连接，等待完整节点状态…',
      onSnapshot: (nextSnapshot) => {
        statusSnapshot.value = nextSnapshot
        updateSummary()
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

  function updateSummary(isMobile = false): void {
    const nodes = Object.values(statusSnapshot.value)
    const onlineCount = nodes.filter(node => node.ONLINE === true).length
    const transmittingCount = nodes.filter(node => node.TYPE !== 'HUB' && node.TX_SOURCE).length
    const fullSummary = `${nodes.length} 个节点 · ${onlineCount} 个在线 · ${transmittingCount} 个正在发射`
    statusMessage.value = isMobile ? `${nodes.length}/${onlineCount}/${transmittingCount}` : fullSummary
  }

  return {
    aiSpotEnabled,
    recentSpots,
    startStatusStream,
    statusMessage,
    statusSnapshot,
    stopStatusStream,
    updateSummary,
  }
})
