import { createRouter, createWebHistory } from 'vue-router'
import AdminPage from './pages/AdminPage.vue'
import TopologyPage from './pages/TopologyPage.vue'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: TopologyPage },
    { path: '/map', component: TopologyPage },
    { path: '/admin', component: AdminPage },
  ],
})
