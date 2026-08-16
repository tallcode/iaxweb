<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import NodeCard from '../components/NodeCard.vue'
import { AudioStreamPlayer } from '../services/audio-player'
import { buildTopologyEdges, createTopologySignature } from '../services/topology-graph'
import { TopologyLayout } from '../services/topology-layout'
import { useStatusStore } from '../stores/status-store'

const emit = defineEmits<{ pageReady: [] }>()
const statusStore = useStatusStore()
const { hasInitialSnapshot, statusSnapshot } = storeToRefs(statusStore)
const topologyElement = ref<HTMLElement | null>(null)
const edgeCanvas = ref<HTMLCanvasElement | null>(null)
const isMobile = ref(false)
const nodeElements = new Map<string, HTMLElement>()
const audioPlayer = new AudioStreamPlayer()
let topologyLayout: TopologyLayout | undefined
let mobileMediaQuery: MediaQueryList | undefined
let resizeObserver: ResizeObserver | undefined
let topologyHeight = 0
let topologyWidth = 0
let mobileRelayoutTimer: ReturnType<typeof setTimeout> | undefined
let hasReportedInitialLayout = false

const nodeIds = computed(() => Object.keys(statusSnapshot.value))

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
  void updateTopologyGraph()
})

onBeforeUnmount(() => {
  void audioPlayer.stop()
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
  if (hasInitialSnapshot.value && !hasReportedInitialLayout) {
    await nextTick()
    hasReportedInitialLayout = true
    emit('pageReady')
  }
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
    <p v-if="hasInitialSnapshot && nodeIds.length === 0" class="empty-state">
      暂无节点数据
    </p>
  </main>
</template>
