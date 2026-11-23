<script setup lang="ts">
import type { AdminRole, AdminSession } from '@iaxweb/contracts'
import type { UserDraft } from '../../composables/use-users-page'
import { nextTick, reactive, ref } from 'vue'

const props = defineProps<{
  currentUsername: string
  roleNames: Record<AdminRole, string>
  saving: boolean
  error: string
}>()
const emit = defineEmits<{
  closed: []
  save: [originalName: string | null, draft: UserDraft]
}>()
const dialog = ref<HTMLDialogElement>()
const editorVisible = ref(false)
const editorTarget = ref<string | null>(null)
const draft = reactive<UserDraft>({ username: '', password: '', role: 'viewer' })

async function open(user?: AdminSession): Promise<void> {
  editorTarget.value = user?.username ?? null
  draft.username = user?.username ?? ''
  draft.password = ''
  draft.role = user?.role ?? 'viewer'
  editorVisible.value = true
  await nextTick()
  dialog.value?.showModal()
}

function close(): void {
  dialog.value?.close()
}

function onClose(): void {
  editorVisible.value = false
  draft.password = ''
  emit('closed')
}

function onCancel(event: Event): void {
  if (props.saving)
    event.preventDefault()
}

function submit(): void {
  emit('save', editorTarget.value, { ...draft })
}

defineExpose({ open, close })
</script>

<template>
  <dialog ref="dialog" aria-labelledby="user-editor-title" class="m-auto w-[calc(100%_-_2rem)] max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-6 text-slate-100 shadow-2xl backdrop:bg-slate-950/75 backdrop:backdrop-blur-sm" @cancel="onCancel" @close="onClose">
    <form v-if="editorVisible" class="space-y-4" @submit.prevent="submit">
      <h2 id="user-editor-title" class="text-lg font-semibold">
        {{ editorTarget === null ? '新增用户' : '编辑用户' }}
      </h2>
      <label class="flex flex-col gap-2 text-sm text-slate-300">
        <span>用户名</span>
        <input v-model="draft.username" required autofocus maxlength="18" autocomplete="off" :disabled="saving" class="block w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 outline-none focus:border-cyan-500">
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
        <input v-model="draft.password" type="password" autocomplete="new-password" maxlength="32" :required="editorTarget === null" :disabled="saving" :placeholder="editorTarget === null ? '请输入密码' : '留空则不修改密码'" class="block w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 outline-none focus:border-cyan-500">
      </label>
      <p v-if="editorTarget === currentUsername" class="text-xs leading-5 text-amber-300">
        修改当前账号的用户名或密码后，需要重新登录。
      </p>
      <p v-if="error" role="alert" class="text-sm text-red-400">
        {{ error }}
      </p>
      <div class="flex justify-end gap-3 pt-2">
        <button type="button" :disabled="saving" class="rounded-lg border border-slate-600 px-4 py-2 text-sm hover:bg-slate-800 focus:outline-none disabled:opacity-50" @click="close()">
          取消
        </button>
        <button type="submit" :disabled="saving" class="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-500 focus:outline-none disabled:opacity-50">
          {{ saving ? '保存中…' : editorTarget === null ? '创建用户' : '保存修改' }}
        </button>
      </div>
    </form>
  </dialog>
</template>
