import { createRouter, createWebHistory } from 'vue-router'
import MapPage from './pages/MapPage.vue'
import TopologyPage from './pages/TopologyPage.vue'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { alias: '/', component: TopologyPage, path: '/topology' },
    { component: MapPage, path: '/map' },
  ],
})
