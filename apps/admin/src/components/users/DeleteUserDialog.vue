<script setup lang="ts">
import type { AdminSession } from '@iaxweb/contracts'
import { nextTick, ref } from 'vue'

const props = defineProps<{
  currentUsername: string
  saving: boolean
  error: string
}>()
const emit = defineEmits<{ closed: [], confirm: [username: string] }>()
const dialog = ref<HTMLDialogElement>()
const deleteTarget = ref<AdminSession | null>(null)

async function open(user: AdminSession): Promise<void> {
  deleteTarget.value = user
  await nextTick()
  dialog.value?.showModal()
}

function close(): void {
  dialog.value?.close()
}

function onClose(): void {
  deleteTarget.value = null
  emit('closed')
}

function onCancel(event: Event): void {
  if (props.saving)
    event.preventDefault()
}

function submit(): void {
  if (deleteTarget.value)
    emit('confirm', deleteTarget.value.username)
}

defineExpose({ open, close })
</script>

<template>
  <dialog ref="dialog" aria-labelledby="user-delete-title" class="m-auto w-[calc(100%_-_2rem)] max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-6 text-slate-100 shadow-2xl backdrop:bg-slate-950/75 backdrop:backdrop-blur-sm" @cancel="onCancel" @close="onClose">
    <form v-if="deleteTarget" @submit.prevent="submit">
      <h2 id="user-delete-title" class="text-lg font-semibold">
        删除用户？
      </h2>
      <p class="mt-3 break-all font-mono text-slate-200">
        {{ deleteTarget.username }}
      </p>
      <p class="mt-3 text-sm leading-6 text-slate-300">
        该用户将被注销，无法继续登录。此操作无法恢复。
      </p>
      <p v-if="deleteTarget.username === currentUsername" class="mt-3 text-sm text-amber-300">
        删除当前账号后将退出登录。
      </p>
      <p v-if="error" role="alert" class="mt-3 text-sm text-red-400">
        {{ error }}
      </p>
      <div class="mt-6 flex justify-end gap-3">
        <button type="button" autofocus :disabled="saving" class="rounded-lg border border-slate-600 px-4 py-2 text-sm hover:bg-slate-800 focus:outline-none disabled:opacity-50" @click="close()">
          取消
        </button>
        <button type="submit" :disabled="saving" class="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500 focus:outline-none disabled:opacity-50">
          {{ saving ? '删除中…' : '确认删除' }}
        </button>
      </div>
    </form>
  </dialog>
</template>
