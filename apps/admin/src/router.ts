import type { AdminSession } from '@iaxweb/contracts'
import { createRouter, createWebHistory } from 'vue-router'
import LoginPage from './pages/LoginPage.vue'
import RecordsPage from './pages/RecordsPage.vue'
import UsersPage from './pages/UsersPage.vue'

export const router = createRouter({
  history: createWebHistory('/admin/'),
  routes: [
    { component: LoginPage, meta: { title: '管理登录' }, path: '/' },
    { component: RecordsPage, meta: { requiresAuth: true, title: '记录管理' }, path: '/records' },
    { component: UsersPage, meta: { requiresAuth: true, requiresAdmin: true, title: '用户管理' }, path: '/users' },
  ],
})

router.beforeEach(async (to) => {
  try {
    const response = await fetch('/api/admin/session')
    const authenticated = response.ok

    if (to.meta.requiresAuth && !authenticated)
      return { path: '/' }
    if (to.meta.requiresAdmin && authenticated) {
      const user = await response.json() as AdminSession
      if (user.role !== 'admin')
        return { path: '/records' }
    }
    if (to.path === '/' && authenticated)
      return { path: '/records' }
  }
  catch {
    if (to.meta.requiresAuth)
      return { path: '/' }
  }
})

router.afterEach((to) => {
  document.title = typeof to.meta.title === 'string' ? to.meta.title : '记录管理'
})
