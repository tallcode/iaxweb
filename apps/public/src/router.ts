import { createRouter, createWebHistory } from 'vue-router'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { alias: '/', component: () => import('./pages/TopologyPage.vue'), path: '/topology' },
    { component: () => import('./pages/MapPage.vue'), path: '/map' },
  ],
})
