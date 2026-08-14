import { createRouter, createWebHistory } from 'vue-router'
import LoginPage from './pages/LoginPage.vue'
import RecordsPage from './pages/RecordsPage.vue'

export const router = createRouter({
  history: createWebHistory('/admin/'),
  routes: [
    { component: LoginPage, path: '/' },
    { component: RecordsPage, meta: { requiresAuth: true }, path: '/records' },
  ],
})

router.beforeEach(async (to) => {
  try {
    const response = await fetch('/api/admin/segments?page=1&pageSize=1')
    const authenticated = response.ok

    if (to.meta.requiresAuth && !authenticated)
      return { path: '/' }
    if (to.path === '/' && authenticated)
      return { path: '/records' }
  }
  catch {
    if (to.meta.requiresAuth)
      return { path: '/' }
  }
})
