<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import SpotPanel from './components/SpotPanel.vue'
import { useMobileLayout } from './composables/use-mobile-layout'
import { useTransmissionFavicon } from './composables/use-transmission-favicon'
import { formatRepeaterSummary } from './services/status-presentation'
import { useStatusStore } from './stores/status-store'

const statusStore = useStatusStore()
const { aiSpotEnabled, hasInitialSnapshot, recentSpots, repeaterSummary, spotHistoryReady, statusSnapshot } = storeToRefs(statusStore)
const route = useRoute()
const isMobile = useMobileLayout()
const isStatsPage = computed(() => route.name === 'stats')
const showSpotPanel = computed(() => aiSpotEnabled.value && !isStatsPage.value)
const readyRoutePath = ref<string>()
const isPageReady = computed(() => readyRoutePath.value === route.fullPath)
const isInitialAppReady = computed(() => (hasInitialSnapshot.value || isStatsPage.value) && isPageReady.value)
const hasEnteredApp = ref(false)
const headerMessage = computed(() => formatRepeaterSummary(repeaterSummary.value, isMobile.value))

useTransmissionFavicon(statusSnapshot)

watch(isInitialAppReady, (ready) => {
  if (ready)
    hasEnteredApp.value = true
}, { immediate: true })

onMounted(() => {
  syncViewportHeight()
  window.addEventListener('resize', syncViewportHeight)
  window.visualViewport?.addEventListener('resize', syncViewportHeight)
  statusStore.startStatusStream()
})

onBeforeUnmount(() => {
  statusStore.stopStatusStream()
  window.removeEventListener('resize', syncViewportHeight)
  window.visualViewport?.removeEventListener('resize', syncViewportHeight)
  document.documentElement.style.removeProperty('--app-height')
})

function syncViewportHeight(): void {
  const height = Math.floor(window.visualViewport?.height ?? window.innerHeight)
  document.documentElement.style.setProperty('--app-height', `${height}px`)
}

function markPageReady(routePath: string): void {
  if (routePath === route.fullPath)
    readyRoutePath.value = routePath
}
</script>

<template>
  <div class="map-shell" :class="{ 'is-mobile': isMobile, 'ai-spot-disabled': !showSpotPanel, 'app-pending': !hasEnteredApp }">
    <header class="map-header">
      <p aria-live="polite" :aria-label="headerMessage">
        {{ headerMessage }}
      </p>
      <nav class="page-nav" aria-label="页面导航">
        <RouterLink to="/topology">
          拓扑图
        </RouterLink>
        <RouterLink to="/map">
          地图
        </RouterLink>
        <RouterLink to="/stats">
          统计
        </RouterLink>
      </nav>
      <div class="legend">
        <span><i class="dot online" />在线</span>
        <span><i class="dot offline" />离线</span>
        <span><i class="dot local" />本地发射</span>
        <span><i class="dot remote" />远程发射</span>
        <span><i class="dot system" />系统发射</span>
      </div>
    </header>
    <RouterView v-slot="{ Component, route: pageRoute }">
      <component :is="Component" :key="pageRoute.fullPath" @page-ready="markPageReady(pageRoute.fullPath)" />
    </RouterView>
    <SpotPanel v-if="showSpotPanel" :history-ready="spotHistoryReady" :spots="recentSpots" />
    <footer class="site-footer">
      <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">浙ICP备20025327号-6</a>
    </footer>
  </div>
  <div v-if="!hasEnteredApp" class="app-loading" role="status" aria-label="页面正在加载" />
</template>
