<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { useRecordDeletionContext } from '../../composables/records/use-records-context'
import { formatRecordTime as formatTime } from '../../utils/records-format'

const emit = defineEmits<{ focusSearch: [] }>()
const { state, confirm, cancel } = useRecordDeletionContext()
const { deletingRecordId, pendingDeletion, error: deleteError } = state
const deleteDialog = ref<HTMLDialogElement>()
let previousFocus: HTMLElement | undefined
watch(pendingDeletion, async (record) => {
  if (!record)
    return
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  await nextTick()
  if (deleteDialog.value && !deleteDialog.value.open) {
    deleteDialog.value.returnValue = ''
    deleteDialog.value.showModal()
  }
}, { flush: 'post' })
function closeDeleteDialog(): void {
  if (cancel())
    deleteDialog.value?.close()
}
function onDeleteDialogCancel(event: Event): void {
  if (!cancel())
    event.preventDefault()
}
function onDeleteDialogClose(): void {
  cancel()
  if (deleteDialog.value?.returnValue !== 'deleted' && previousFocus?.isConnected && previousFocus.getClientRects().length > 0)
    previousFocus.focus()
  else
    emit('focusSearch')
  previousFocus = undefined
}
async function deleteRecord(): Promise<void> {
  if (await confirm())
    deleteDialog.value?.close('deleted')
}
</script>

<template>
  <dialog ref="deleteDialog" aria-labelledby="delete-dialog-title" aria-describedby="delete-dialog-description" class="m-auto w-[calc(100%_-_2rem)] max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-6 text-slate-100 shadow-2xl backdrop:bg-slate-950/75 backdrop:backdrop-blur-sm" @cancel="onDeleteDialogCancel" @close="onDeleteDialogClose">
    <form v-if="pendingDeletion" @submit.prevent="deleteRecord">
      <h2 id="delete-dialog-title" class="text-lg font-semibold">
        删除这条记录？
      </h2>
      <p id="delete-dialog-description" class="mt-2 text-sm leading-6 text-slate-300">
        数据库记录和对应录音将被永久删除，无法恢复。
      </p>
      <div class="mt-4 rounded-lg border border-slate-700 bg-slate-950/60 p-3">
        <p class="text-xs text-slate-400">
          {{ formatTime(pendingDeletion.capturedAt) }}
          <span class="ml-2 font-mono">{{ pendingDeletion.effectiveCallsign ?? '无主叫呼号' }}</span>
        </p>
        <p class="mt-2 line-clamp-4 whitespace-pre-wrap break-words text-sm leading-6 text-slate-200">
          {{ pendingDeletion.manualRecognition ?? pendingDeletion.recognition }}
        </p>
      </div>
      <p v-if="deleteError" role="alert" class="mt-3 text-sm text-red-400">
        {{ deleteError }}
      </p>
      <div class="mt-6 flex justify-end gap-3">
        <button type="button" autofocus :disabled="deletingRecordId !== null" class="rounded-lg border border-slate-600 px-4 py-2 text-sm transition hover:bg-slate-800 focus:outline-none disabled:cursor-wait disabled:opacity-50" @click="closeDeleteDialog">
          取消
        </button>
        <button type="submit" :disabled="deletingRecordId !== null" class="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-500 focus:outline-none disabled:cursor-wait disabled:opacity-50">
          {{ deletingRecordId !== null ? '删除中…' : '确认删除' }}
        </button>
      </div>
    </form>
  </dialog>
</template>
