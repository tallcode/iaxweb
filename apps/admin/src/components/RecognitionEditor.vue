<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import TextDiff from './TextDiff.vue'

const props = defineProps<{
  original: string
  manual: string | null
  disabled: boolean
  readOnly?: boolean
  save: (value: string | null) => Promise<boolean>
}>()
const emit = defineEmits<{ editing: [value: boolean] }>()
const editing = ref(false)
const draft = ref('')
const textarea = ref<HTMLTextAreaElement>()
const saving = ref(false)

watch(() => props.readOnly, (readOnly) => {
  if (readOnly && editing.value) {
    editing.value = false
    emit('editing', false)
  }
})

async function begin(): Promise<void> {
  if (props.disabled || props.readOnly)
    return
  draft.value = props.manual ?? props.original
  editing.value = true
  emit('editing', true)
  await nextTick()
  textarea.value?.focus()
}

function cancel(): void {
  if (saving.value || !editing.value)
    return
  editing.value = false
  emit('editing', false)
}

async function submit(): Promise<void> {
  if (saving.value)
    return
  saving.value = true
  try {
    if (await props.save(draft.value.trim() || null) && editing.value) {
      editing.value = false
      emit('editing', false)
    }
  }
  finally {
    saving.value = false
  }
}

function keydown(event: KeyboardEvent): void {
  if (event.isComposing)
    return
  if (event.key === 'Escape') {
    event.preventDefault()
    cancel()
  }
  else if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    void submit()
  }
}

onBeforeUnmount(() => {
  if (editing.value) {
    editing.value = false
    emit('editing', false)
  }
})
</script>

<template>
  <form v-if="editing" class="space-y-2" @submit.prevent="submit">
    <textarea ref="textarea" v-model="draft" rows="4" maxlength="20000" aria-label="编辑识别文本" :disabled="saving" class="block w-full resize-y rounded-md border border-slate-700 bg-slate-950 px-2.5 py-2 text-sm leading-6 text-slate-100 outline-none focus:border-cyan-500 disabled:opacity-50" @keydown="keydown" />
    <div class="flex flex-wrap items-center gap-2 text-xs">
      <button type="submit" :disabled="saving" class="rounded-md border border-emerald-700 px-2.5 py-1 text-emerald-300 disabled:opacity-50">
        {{ saving ? '保存中…' : '保存' }}
      </button>
      <button type="button" :disabled="saving" class="rounded-md border border-slate-700 px-2.5 py-1 text-slate-300 disabled:opacity-50" @click="cancel">
        取消
      </button>
      <span class="text-slate-500">Enter 保存 · Shift+Enter 换行 · 清空恢复 AI 文本</span>
    </div>
  </form>
  <div v-else-if="readOnly" class="whitespace-pre-wrap break-words text-sm leading-6" :class="manual !== null ? 'text-emerald-400' : 'text-slate-100'">
    <TextDiff :original="original" :manual="manual" />
  </div>
  <button v-else type="button" :disabled="disabled" aria-label="编辑识别文本" class="block w-full cursor-text whitespace-pre-wrap break-words text-left text-sm leading-6 focus:outline-none focus:ring-1 focus:ring-cyan-500 disabled:cursor-wait" :class="manual !== null ? 'text-emerald-400' : 'text-slate-100'" @click="begin">
    <TextDiff :original="original" :manual="manual" />
  </button>
</template>
