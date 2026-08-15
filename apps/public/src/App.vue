<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { onBeforeUnmount, onMounted, ref } from 'vue'
import SpotPanel from './components/SpotPanel.vue'
import { useTransmissionFavicon } from './composables/use-transmission-favicon'
import { useStatusStore } from './stores/status-store'

const statusStore = useStatusStore()
const { aiSpotEnabled, recentSpots, statusMessage, statusSnapshot } = storeToRefs(statusStore)
const isMobile = ref(false)
let mobileMediaQuery: MediaQueryList | undefined

useTransmissionFavicon(statusSnapshot)

onMounted(() => {
  mobileMediaQuery = matchMedia('(max-width: 680px)')
  isMobile.value = mobileMediaQuery.matches
  mobileMediaQuery.addEventListener('change', updateMobileState)
  statusStore.startStatusStream()
  statusStore.updateSummary(isMobile.value)
})

onBeforeUnmount(() => {
  statusStore.stopStatusStream()
  mobileMediaQuery?.removeEventListener('change', updateMobileState)
})

function updateMobileState(event: MediaQueryListEvent): void {
  isMobile.value = event.matches
  statusStore.updateSummary(isMobile.value)
}
</script>

<template>
  <div class="map-shell" :class="{ 'ai-spot-disabled': !aiSpotEnabled }">
    <header class="map-header">
      <p class="m-0 text-[0.82rem] text-[#96a4b7] max-[680px]:whitespace-nowrap max-[680px]:text-[0.68rem]" aria-live="polite" :aria-label="statusMessage">
        {{ statusMessage }}
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
    <RouterView />
    <SpotPanel v-if="aiSpotEnabled" :spots="recentSpots" />
    <footer class="site-footer">
      <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">浙ICP备20025327号-6</a>
    </footer>
  </div>
</template>
