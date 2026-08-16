<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import SpotPanel from './components/SpotPanel.vue'
import { useTransmissionFavicon } from './composables/use-transmission-favicon'
import { formatRepeaterSummary } from './services/status-presentation'
import { useStatusStore } from './stores/status-store'

const statusStore = useStatusStore()
const { aiSpotEnabled, hasInitialSnapshot, recentSpots, repeaterSummary, spotHistoryReady, statusSnapshot } = storeToRefs(statusStore)
const route = useRoute()
const isMobile = ref(false)
const readyRoutePath = ref<string>()
const isPageReady = computed(() => readyRoutePath.value === route.fullPath)
const isInitialAppReady = computed(() => hasInitialSnapshot.value && isPageReady.value)
const hasEnteredApp = ref(false)
const headerMessage = computed(() => formatRepeaterSummary(repeaterSummary.value, isMobile.value))
let mobileMediaQuery: MediaQueryList | undefined

useTransmissionFavicon(statusSnapshot)

watch(isInitialAppReady, (ready) => {
  if (ready)
    hasEnteredApp.value = true
}, { immediate: true })

onMounted(() => {
  mobileMediaQuery = matchMedia('(max-width: 680px)')
  isMobile.value = mobileMediaQuery.matches
  mobileMediaQuery.addEventListener('change', updateMobileState)
  statusStore.startStatusStream()
})

onBeforeUnmount(() => {
  statusStore.stopStatusStream()
  mobileMediaQuery?.removeEventListener('change', updateMobileState)
})

function updateMobileState(event: MediaQueryListEvent): void {
  isMobile.value = event.matches
}

function markPageReady(routePath: string): void {
  if (routePath === route.fullPath)
    readyRoutePath.value = routePath
}
</script>

<template>
  <div class="map-shell" :class="{ 'ai-spot-disabled': !aiSpotEnabled, 'app-pending': !hasEnteredApp }">
    <header class="map-header">
      <p class="m-0 text-[0.82rem] text-[#96a4b7] max-[680px]:whitespace-nowrap max-[680px]:text-[0.68rem]" aria-live="polite" :aria-label="headerMessage">
        {{ headerMessage }}
      </p>
      <nav class="page-nav" aria-label="页面导航">
        <RouterLink to="/topology">
          拓扑图
        </RouterLink>
        <RouterLink to="/map">
          地图
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
    <SpotPanel v-if="aiSpotEnabled" :history-ready="spotHistoryReady" :spots="recentSpots" />
    <footer class="site-footer">
      <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">浙ICP备20025327号-6</a>
    </footer>
  </div>
  <div v-if="!hasEnteredApp" class="app-loading" role="status" aria-label="页面正在加载" />
</template>
