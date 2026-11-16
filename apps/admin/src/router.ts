import { createRouter, createWebHistory } from 'vue-router'
import { refreshAdminSession } from './admin-session'
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
    const user = await refreshAdminSession()
    const authenticated = user !== null

    if (to.meta.requiresAuth && !authenticated)
      return { path: '/' }
    if (to.meta.requiresAdmin && authenticated && user.role !== 'admin')
      return { path: '/records' }
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
