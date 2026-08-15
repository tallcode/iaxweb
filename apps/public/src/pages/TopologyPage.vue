<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import NodeCard from '../components/NodeCard.vue'
import SpotPanel from '../components/SpotPanel.vue'
import { AudioStreamPlayer } from '../services/audio-player'
import { buildTopologyEdges, createTopologySignature } from '../services/topology-graph'
import { TopologyLayout } from '../services/topology-layout'
import { TransmissionFavicon } from '../services/transmission-favicon'
import { useStatusStore } from '../stores/status-store'

const statusStore = useStatusStore()
const { aiSpotEnabled, recentSpots, statusMessage, statusSnapshot } = storeToRefs(statusStore)
const topologyElement = ref<HTMLElement | null>(null)
const edgeCanvas = ref<HTMLCanvasElement | null>(null)
const isMobile = ref(false)
const nodeElements = new Map<string, HTMLElement>()
const audioPlayer = new AudioStreamPlayer()
let transmissionFavicon: TransmissionFavicon | undefined
let topologyLayout: TopologyLayout | undefined
let mobileMediaQuery: MediaQueryList | undefined
let resizeObserver: ResizeObserver | undefined
let topologyHeight = 0
let topologyWidth = 0
let mobileRelayoutTimer: ReturnType<typeof setTimeout> | undefined

const nodeIds = computed(() => Object.keys(statusSnapshot.value))
const summaryLabel = computed(() => {
  const nodes = Object.values(statusSnapshot.value)
  const onlineCount = nodes.filter(node => node.ONLINE === true).length
  const transmittingCount = nodes.filter(node => node.TYPE !== 'HUB' && node.TX_SOURCE).length
  return `${nodes.length} 个节点 · ${onlineCount} 个在线 · ${transmittingCount} 个正在发射`
})

onMounted(() => {
  syncViewportHeight()
  window.addEventListener('resize', syncViewportHeight)
  window.visualViewport?.addEventListener('resize', syncViewportHeight)
  mobileMediaQuery = matchMedia('(max-width: 680px)')
  isMobile.value = mobileMediaQuery.matches
  mobileMediaQuery.addEventListener('change', handleMobileBreakpointChange)

  if (topologyElement.value && edgeCanvas.value) {
    topologyWidth = topologyElement.value.clientWidth
    topologyHeight = topologyElement.value.clientHeight
    topologyLayout = new TopologyLayout(
      topologyElement.value,
      edgeCanvas.value,
      nodeElements,
      matchMedia('(prefers-reduced-motion: reduce)').matches,
    )
    resizeObserver = new ResizeObserver(([entry]) => {
      if (!entry)
        return
      const width = Math.round(entry.contentRect.width)
      const height = Math.round(entry.contentRect.height)
      if (width === topologyWidth && height === topologyHeight)
        return
      topologyWidth = width
      topologyHeight = height
      topologyLayout?.relayout()
    })
    resizeObserver.observe(topologyElement.value)
  }
  transmissionFavicon = new TransmissionFavicon()
  statusStore.startStatusStream()
  statusStore.updateSummary(isMobile.value)
  void updateTopologyGraph()
})

onBeforeUnmount(() => {
  statusStore.stopStatusStream()
  void audioPlayer.stop()
  transmissionFavicon?.setTransmitting(false)
  if (mobileRelayoutTimer)
    clearTimeout(mobileRelayoutTimer)
  resizeObserver?.disconnect()
  mobileMediaQuery?.removeEventListener('change', handleMobileBreakpointChange)
  window.removeEventListener('resize', syncViewportHeight)
  window.visualViewport?.removeEventListener('resize', syncViewportHeight)
})

watch(statusSnapshot, () => void updateTopologyGraph(), { deep: true })
watch(isMobile, () => {
  audioPlayer.setVisualizationEnabled(!isMobile.value)
  statusStore.updateSummary(isMobile.value)
  void updateTopologyGraph()
})

function registerNodeElement(nodeId: string, element: HTMLElement | null): void {
  if (element) {
    nodeElements.set(nodeId, element)
  }
  else {
    nodeElements.delete(nodeId)
    topologyLayout?.removeNode(nodeId)
  }
}

async function updateTopologyGraph(): Promise<void> {
  await nextTick()
  if (!topologyLayout)
    return
  const ids = nodeIds.value
  const active = new Set(ids)
  for (const nodeId of nodeElements.keys()) {
    if (!active.has(nodeId)) {
      nodeElements.delete(nodeId)
      topologyLayout.removeNode(nodeId)
    }
  }
  ids.forEach((nodeId, index) => topologyLayout?.ensureNode(nodeId, index, ids.length))
  const edges = buildTopologyEdges(statusSnapshot.value)
  topologyLayout.updateGraph(edges, createTopologySignature(ids, edges, isMobile.value))
  transmissionFavicon?.setTransmitting(ids.some((nodeId) => {
    const node = statusSnapshot.value[nodeId]
    return node?.TYPE !== 'HUB' && Boolean(node?.TX_SOURCE)
  }))
}

function handleMobileBreakpointChange(event: MediaQueryListEvent): void {
  isMobile.value = event.matches
}

function scheduleMobileRelayout(): void {
  if (mobileRelayoutTimer)
    clearTimeout(mobileRelayoutTimer)
  // Wait for the card's size transition so collision bounds use its final size.
  mobileRelayoutTimer = setTimeout(() => {
    mobileRelayoutTimer = undefined
    topologyLayout?.relayout()
  }, 240)
}

function syncViewportHeight(): void {
  const height = Math.floor(window.visualViewport?.height ?? window.innerHeight)
  document.documentElement.style.setProperty('--app-height', `${height}px`)
}
</script>

<template>
  <div class="map-shell" :class="{ 'ai-spot-disabled': !aiSpotEnabled }">
    <header class="map-header">
      <p class="m-0 text-[0.82rem] text-[#96a4b7] max-[680px]:whitespace-nowrap max-[680px]:text-[0.68rem]" aria-live="polite" :aria-label="summaryLabel">
        {{ statusMessage }}
      </p>
      <div class="legend" aria-label="状态图例">
        <span><i class="dot online" />在线</span>
        <span><i class="dot offline" />离线</span>
        <span><i class="dot local" />本地发射</span>
        <span><i class="dot remote" />远程发射</span>
        <span><i class="dot system" />系统发射</span>
      </div>
    </header>
    <main ref="topologyElement" class="topology" aria-label="AllStarLink 节点连接拓扑">
      <canvas ref="edgeCanvas" class="edges" aria-hidden="true" />
      <div class="nodes">
        <NodeCard
          v-for="nodeId in nodeIds"
          :key="nodeId"
          :is-mobile="isMobile"
          :node="statusSnapshot[nodeId]!"
          :node-id="nodeId"
          :audio-player="audioPlayer"
          @register="registerNodeElement"
          @layout-change="scheduleMobileRelayout"
        />
      </div>
      <p v-if="nodeIds.length === 0" class="empty-state">
        等待完整节点状态…
      </p>
    </main>
    <SpotPanel v-if="aiSpotEnabled" :spots="recentSpots" />
    <footer class="site-footer">
      <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">浙ICP备20025327号-6</a>
    </footer>
  </div>
</template>
