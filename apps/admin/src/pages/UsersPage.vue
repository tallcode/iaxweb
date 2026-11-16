<script setup lang="ts">
import type { AdminRole, AdminSession, AdminUsersPage } from '@iaxweb/contracts'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { adminSession as currentUser } from '../admin-session'
import AdminPageHeader from '../components/AdminPageHeader.vue'

const router = useRouter()
const users = ref<AdminSession[]>([])
const search = ref('')
const status = ref('')
const loading = ref(false)
const saving = ref(false)
const loggingOut = ref(false)
const editorVisible = ref(false)
const editorTarget = ref<string | null>(null)
const editorDialog = ref<HTMLDialogElement>()
const editorError = ref('')
const draft = reactive({ username: '', password: '', role: 'viewer' as AdminRole })
const deleteTarget = ref<AdminSession | null>(null)
const deleteDialog = ref<HTMLDialogElement>()
const deleteError = ref('')
const addButton = ref<HTMLButtonElement>()
const roleNames: Record<AdminRole, string> = { admin: '管理', editor: '编辑', viewer: '查看' }
let request: AbortController | undefined
let dialogTrigger: HTMLElement | undefined

const filteredUsers = computed(() => {
  const keyword = search.value.trim().toLocaleLowerCase()
  return users.value.filter(user => !keyword || user.username.toLocaleLowerCase().includes(keyword))
})

onMounted(() => void loadUsers())
onBeforeUnmount(() => request?.abort())

async function checkAccess(response: Response): Promise<boolean> {
  if (response.status === 401) {
    await router.replace('/')
    return false
  }
  if (response.status === 403) {
    await router.replace('/records')
    return false
  }
  return true
}

async function responseError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { message?: unknown }
    return typeof body.message === 'string' ? body.message : fallback
  }
  catch {
    return fallback
  }
}

async function loadUsers(): Promise<void> {
  request?.abort()
  const activeRequest = new AbortController()
  request = activeRequest
  loading.value = true
  status.value = ''
  try {
    const response = await fetch('/api/admin/users', { signal: activeRequest.signal })
    if (activeRequest.signal.aborted || !await checkAccess(response))
      return
    if (!response.ok) {
      status.value = await responseError(response, '加载用户失败，请重试')
      return
    }
    const page = await response.json() as AdminUsersPage
    if (activeRequest.signal.aborted)
      return
    users.value = page.items
  }
  catch {
    if (!activeRequest.signal.aborted)
      status.value = '加载用户失败：无法连接服务器'
  }
  finally {
    if (request === activeRequest) {
      loading.value = false
      request = undefined
    }
  }
}

async function logout(): Promise<void> {
  if (loggingOut.value || saving.value)
    return
  loggingOut.value = true
  request?.abort()
  try {
    const response = await fetch('/api/admin/logout', { method: 'POST' })
    if (!response.ok && response.status !== 401) {
      status.value = '注销失败，请重试'
      return
    }
    users.value = []
    currentUser.value = null
    await router.replace('/')
  }
  catch {
    status.value = '注销失败：无法连接服务器'
  }
  finally {
    loggingOut.value = false
  }
}

async function openEditor(user: AdminSession | undefined, event: MouseEvent): Promise<void> {
  if (saving.value || loggingOut.value)
    return
  dialogTrigger = event.currentTarget as HTMLElement
  editorTarget.value = user?.username ?? null
  draft.username = user?.username ?? ''
  draft.password = ''
  draft.role = user?.role ?? 'viewer'
  editorError.value = ''
  editorVisible.value = true
  await nextTick()
  editorDialog.value?.showModal()
}

function restoreFocus(): void {
  if (dialogTrigger?.isConnected)
    dialogTrigger.focus()
  else
    addButton.value?.focus()
  dialogTrigger = undefined
}

function onEditorClose(): void {
  editorVisible.value = false
  draft.password = ''
  restoreFocus()
}

function onCancel(event: Event): void {
  if (saving.value)
    event.preventDefault()
}

async function saveUser(): Promise<void> {
  if (saving.value)
    return
  saving.value = true
  editorError.value = ''
  const originalName = editorTarget.value
  const isCurrentUser = originalName !== null && originalName === currentUser.value?.username
  const body = { username: draft.username.trim(), role: draft.role, ...(draft.password ? { password: draft.password } : {}) }
  try {
    const response = await fetch(originalName === null ? '/api/admin/users' : `/api/admin/users/${encodeURIComponent(originalName)}`, {
      method: originalName === null ? 'POST' : 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!await checkAccess(response))
      return
    if (!response.ok) {
      editorError.value = await responseError(response, '保存用户失败，请重试')
      return
    }
    if (isCurrentUser && (body.username !== originalName || body.password)) {
      editorDialog.value?.close()
      await router.replace('/')
      return
    }
    if (isCurrentUser && body.role !== 'admin') {
      editorDialog.value?.close()
      await router.replace('/records')
      return
    }
    await loadUsers()
    editorDialog.value?.close()
  }
  catch {
    editorError.value = '保存用户失败：无法连接服务器'
  }
  finally {
    saving.value = false
  }
}

async function openDelete(user: AdminSession, event: MouseEvent): Promise<void> {
  if (saving.value || loggingOut.value)
    return
  dialogTrigger = event.currentTarget as HTMLElement
  deleteTarget.value = user
  deleteError.value = ''
  await nextTick()
  deleteDialog.value?.showModal()
}

function onDeleteClose(): void {
  deleteTarget.value = null
  restoreFocus()
}

async function deleteUser(): Promise<void> {
  const user = deleteTarget.value
  if (!user || saving.value)
    return
  saving.value = true
  deleteError.value = ''
  try {
    const response = await fetch(`/api/admin/users/${encodeURIComponent(user.username)}`, { method: 'DELETE' })
    if (!await checkAccess(response))
      return
    if (!response.ok && response.status !== 404) {
      deleteError.value = await responseError(response, '删除用户失败，请重试')
      return
    }
    if (user.username === currentUser.value?.username) {
      deleteDialog.value?.close()
      await router.replace('/')
      return
    }
    await loadUsers()
    deleteDialog.value?.close()
  }
  catch {
    deleteError.value = '删除用户失败：无法连接服务器'
  }
  finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="min-h-dvh min-w-[380px] bg-slate-950 text-slate-100">
    <AdminPageHeader title="用户管理" :username="currentUser?.username ?? ''" :logging-out="loggingOut" :disabled="saving" @logout="logout">
      <RouterLink to="/records" class="shrink-0 text-xs text-slate-400 transition hover:text-slate-100 sm:text-sm">
        记录管理
      </RouterLink>
    </AdminPageHeader>
    <main :inert="loggingOut" class="mx-auto w-full max-w-screen-2xl px-4 pt-32 pb-6 sm:px-6 lg:px-8">
      <div class="fixed inset-x-0 top-16 z-20 h-16 min-w-[380px] bg-slate-950" aria-label="筛选工具栏">
        <div class="mx-auto flex h-full max-w-screen-2xl flex-nowrap items-center gap-3 px-4 py-3 sm:px-6 lg:px-8">
          <p class="shrink-0 whitespace-nowrap text-sm text-slate-400">
            <span class="sm:hidden">{{ filteredUsers.length }}人</span>
            <span class="hidden sm:inline">共 {{ filteredUsers.length }} 个用户</span>
          </p>
          <div class="ml-auto flex items-center gap-2">
            <input v-model="search" type="search" maxlength="64" aria-label="搜索用户名" placeholder="用户名" autocomplete="off" class="w-[calc(16ch+1.5rem+2px)] flex-none rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm outline-none focus:border-cyan-500">
            <button ref="addButton" type="button" aria-label="新增用户" :disabled="loading || saving || loggingOut" class="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg bg-cyan-600 px-3 py-2 text-sm text-white transition hover:bg-cyan-500 focus:outline-none disabled:opacity-50" @click="openEditor(undefined, $event)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="size-4" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
              <span>新增用户</span>
            </button>
          </div>
        </div>
      </div>
      <p v-if="status" role="alert" class="mb-3 text-sm text-red-400">
        {{ status }}
      </p>
      <div class="rounded-xl border border-slate-800 bg-slate-900/70">
        <table class="w-full table-fixed divide-y divide-slate-800 text-left text-sm">
          <colgroup><col><col class="w-24 sm:w-40"><col class="w-24"></colgroup>
          <thead class="sticky top-32 z-10 bg-slate-900 text-xs text-slate-400">
            <tr>
              <th class="px-4 py-3">
                用户名
              </th><th class="px-3 py-3">
                角色
              </th><th class="px-3 py-3">
                操作
              </th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-800/80">
            <tr v-for="user in filteredUsers" :key="user.username" class="hover:bg-slate-800/40">
              <td class="break-all px-4 py-4 font-mono text-slate-200">
                {{ user.username }}<span v-if="user.username === currentUser?.username" class="ml-2 whitespace-nowrap font-sans text-xs text-slate-500">当前账号</span>
              </td>
              <td class="px-3 py-4">
                <span class="whitespace-nowrap text-xs text-white">{{ roleNames[user.role] }}</span>
              </td>
              <td class="px-3 py-3">
                <div class="flex gap-1">
                  <button type="button" aria-label="编辑用户" title="编辑用户" :disabled="saving" class="inline-flex size-8 items-center justify-center rounded-md text-slate-400 hover:bg-cyan-500/10 hover:text-cyan-300 focus:outline-none disabled:opacity-40" @click="openEditor(user, $event)">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="size-4" aria-hidden="true"><path d="m16 3 5 5-12 12-6 1 1-6L16 3ZM13 6l5 5" /></svg>
                  </button>
                  <button type="button" aria-label="删除用户" title="删除用户" :disabled="saving" class="inline-flex size-8 items-center justify-center rounded-md text-red-400 hover:bg-red-500/10 hover:text-red-300 focus:outline-none disabled:opacity-40" @click="openDelete(user, $event)">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="size-4" aria-hidden="true"><path d="M3 6h18M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M5 6l1 14a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1l1-14M10 10v7M14 10v7" /></svg>
                  </button>
                </div>
              </td>
            </tr>
            <tr v-if="!filteredUsers.length">
              <td colspan="3" class="px-4 py-12 text-center text-sm text-slate-500">
                {{ loading ? '加载中…' : search ? '没有匹配的用户' : '暂无用户' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </main>

    <dialog ref="editorDialog" aria-labelledby="user-editor-title" class="m-auto w-[calc(100%_-_2rem)] max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-6 text-slate-100 shadow-2xl backdrop:bg-slate-950/75 backdrop:backdrop-blur-sm" @cancel="onCancel" @close="onEditorClose">
      <form v-if="editorVisible" class="space-y-4" @submit.prevent="saveUser">
        <h2 id="user-editor-title" class="text-lg font-semibold">
          {{ editorTarget === null ? '新增用户' : '编辑用户' }}
        </h2>
        <label class="flex flex-col gap-2 text-sm text-slate-300">
          <span>用户名</span>
          <input v-model="draft.username" required autofocus maxlength="64" autocomplete="off" :disabled="saving" class="block w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 outline-none focus:border-cyan-500">
        </label>
        <label class="flex flex-col gap-2 text-sm text-slate-300">
          <span>角色</span>
          <div class="relative">
            <select v-model="draft.role" :disabled="saving" class="block w-full appearance-none rounded-lg border border-slate-700 bg-slate-950 py-2 pr-10 pl-3 text-white outline-none focus:border-cyan-500"><option v-for="(label, role) in roleNames" :key="role" :value="role">{{ label }}</option></select>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-white" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
          </div>
        </label>
        <p class="text-xs leading-5 text-slate-500">
          {{ draft.role === 'admin' ? '可编辑、标注、删除记录，并管理用户。' : draft.role === 'editor' ? '仅可编辑识别文本、主叫和被叫。' : '仅可浏览、搜索、筛选及播放录音。' }}
        </p>
        <label class="flex flex-col gap-2 text-sm text-slate-300">
          <span>{{ editorTarget === null ? '密码' : '新密码' }}</span>
          <input v-model="draft.password" type="password" autocomplete="new-password" maxlength="1024" :required="editorTarget === null" :disabled="saving" :placeholder="editorTarget === null ? '请输入密码' : '留空则不修改密码'" class="block w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 outline-none focus:border-cyan-500">
        </label>
        <p v-if="editorTarget === currentUser?.username" class="text-xs leading-5 text-amber-300">
          修改当前账号的用户名或密码后，需要重新登录。
        </p>
        <p v-if="editorError" role="alert" class="text-sm text-red-400">
          {{ editorError }}
        </p>
        <div class="flex justify-end gap-3 pt-2">
          <button type="button" :disabled="saving" class="rounded-lg border border-slate-600 px-4 py-2 text-sm hover:bg-slate-800 focus:outline-none disabled:opacity-50" @click="editorDialog?.close()">
            取消
          </button>
          <button type="submit" :disabled="saving" class="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-500 focus:outline-none disabled:opacity-50">
            {{ saving ? '保存中…' : editorTarget === null ? '创建用户' : '保存修改' }}
          </button>
        </div>
      </form>
    </dialog>

    <dialog ref="deleteDialog" aria-labelledby="user-delete-title" class="m-auto w-[calc(100%_-_2rem)] max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-6 text-slate-100 shadow-2xl backdrop:bg-slate-950/75 backdrop:backdrop-blur-sm" @cancel="onCancel" @close="onDeleteClose">
      <form v-if="deleteTarget" @submit.prevent="deleteUser">
        <h2 id="user-delete-title" class="text-lg font-semibold">
          删除用户？
        </h2>
        <p class="mt-3 break-all font-mono text-slate-200">
          {{ deleteTarget.username }}
        </p>
        <p class="mt-3 text-sm leading-6 text-slate-300">
          该用户将被注销，无法继续登录。此操作无法恢复。
        </p>
        <p v-if="deleteTarget.username === currentUser?.username" class="mt-3 text-sm text-amber-300">
          删除当前账号后将退出登录。
        </p>
        <p v-if="deleteError" role="alert" class="mt-3 text-sm text-red-400">
          {{ deleteError }}
        </p>
        <div class="mt-6 flex justify-end gap-3">
          <button type="button" autofocus :disabled="saving" class="rounded-lg border border-slate-600 px-4 py-2 text-sm hover:bg-slate-800 focus:outline-none disabled:opacity-50" @click="deleteDialog?.close()">
            取消
          </button>
          <button type="submit" :disabled="saving" class="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500 focus:outline-none disabled:opacity-50">
            {{ saving ? '删除中…' : '确认删除' }}
          </button>
        </div>
      </form>
    </dialog>
  </div>
</template>
