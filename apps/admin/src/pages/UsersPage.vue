<script setup lang="ts">
import type { AdminRole, AdminSession } from '@iaxweb/contracts'
import type { UserDraft } from '../composables/use-users-page'
import { ref } from 'vue'
import { RouterLink } from 'vue-router'
import AdminPageHeader from '../components/AdminPageHeader.vue'
import DeleteUserDialog from '../components/users/DeleteUserDialog.vue'
import UserEditorDialog from '../components/users/UserEditorDialog.vue'
import { useUsersPage } from '../composables/use-users-page'

const { currentUser, filteredUsers, search, status, loading, saving, loggingOut, editorError, deleteError, logout, saveUser, deleteUser } = useUsersPage()
const editorDialog = ref<InstanceType<typeof UserEditorDialog>>()
const deleteDialog = ref<InstanceType<typeof DeleteUserDialog>>()
const addButton = ref<HTMLButtonElement>()
const roleNames: Record<AdminRole, string> = { admin: '管理', editor: '编辑', viewer: '查看' }
let dialogTrigger: HTMLElement | undefined

function openEditor(user: AdminSession | undefined, event: MouseEvent): void {
  if (saving.value || loggingOut.value)
    return
  dialogTrigger = event.currentTarget as HTMLElement
  editorError.value = ''
  void editorDialog.value?.open(user)
}

function openDelete(user: AdminSession, event: MouseEvent): void {
  if (saving.value || loggingOut.value)
    return
  dialogTrigger = event.currentTarget as HTMLElement
  deleteError.value = ''
  void deleteDialog.value?.open(user)
}

function restoreFocus(): void {
  if (dialogTrigger?.isConnected)
    dialogTrigger.focus()
  else
    addButton.value?.focus()
  dialogTrigger = undefined
}

function submitEditor(originalName: string | null, draft: UserDraft): void {
  void saveUser(originalName, draft, () => editorDialog.value?.close())
}

function confirmDelete(username: string): void {
  void deleteUser(username, () => deleteDialog.value?.close())
}
</script>

<template>
  <div class="min-h-dvh bg-slate-950 text-slate-100">
    <AdminPageHeader title="用户管理" :username="currentUser?.username ?? ''" :logging-out="loggingOut" :disabled="saving" @logout="logout">
      <RouterLink to="/records" class="shrink-0 text-xs text-slate-400 transition hover:text-slate-100 sm:text-sm">
        记录管理
      </RouterLink>
    </AdminPageHeader>
    <main :inert="loggingOut" class="mx-auto w-full max-w-screen-2xl px-4 pt-32 pb-6 sm:px-6 lg:px-8">
      <div class="fixed inset-x-0 top-16 z-20 h-16 bg-slate-950" aria-label="筛选工具栏">
        <div class="mx-auto flex h-full max-w-screen-2xl flex-nowrap items-center gap-3 px-4 py-3 sm:px-6 lg:px-8">
          <p class="shrink-0 whitespace-nowrap text-sm text-slate-400">
            <span class="sm:hidden">{{ filteredUsers.length }}人</span>
            <span class="hidden sm:inline">共 {{ filteredUsers.length }} 个用户</span>
          </p>
          <div class="ml-auto flex items-center gap-2">
            <input v-model="search" type="search" maxlength="64" aria-label="搜索用户名" placeholder="用户名" autocomplete="off" class="w-[calc(16ch+1.5rem+2px)] flex-none rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm outline-none focus:border-cyan-500">
            <button ref="addButton" type="button" aria-label="新增用户" :disabled="loading || saving || loggingOut" class="inline-flex size-10 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-cyan-600 text-sm text-white transition hover:bg-cyan-500 focus:outline-none disabled:opacity-50 sm:h-auto sm:w-auto sm:px-3 sm:py-2" @click="openEditor(undefined, $event)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="size-4" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
              <span class="hidden sm:inline">新增用户</span>
            </button>
          </div>
        </div>
      </div>
      <p v-if="status" role="alert" class="mb-3 text-sm text-red-400">
        {{ status }}
      </p>
      <div class="overflow-clip rounded-xl border border-slate-800 bg-slate-900/70">
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

    <UserEditorDialog ref="editorDialog" :current-username="currentUser?.username ?? ''" :role-names="roleNames" :saving="saving" :error="editorError" @save="submitEditor" @closed="restoreFocus" />
    <DeleteUserDialog ref="deleteDialog" :current-username="currentUser?.username ?? ''" :saving="saving" :error="deleteError" @confirm="confirmDelete" @closed="restoreFocus" />
  </div>
</template>
