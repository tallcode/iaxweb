<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps<{
  value: string | null
  label: string
  pattern: RegExp
  hint: string
  disabled: boolean
  save: (value: string | null) => Promise<boolean>
}>()
const emit = defineEmits<{ close: [] }>()
const input = ref<HTMLInputElement>()
const draft = ref(props.value ?? '')
const saving = ref(false)

onMounted(() => {
  input.value?.focus()
  input.value?.select()
})
onBeforeUnmount(() => emit('close'))

function cancel(): void {
  if (!saving.value && !props.disabled)
    emit('close')
}

async function submit(): Promise<void> {
  if (saving.value || props.disabled || !input.value)
    return
  const value = draft.value.trim().toUpperCase()
  input.value.setCustomValidity(value.length === 0 || props.pattern.test(value) ? '' : props.hint)
  if (!input.value.reportValidity())
    return
  saving.value = true
  try {
    if (await props.save(value || null))
      emit('close')
  }
  finally {
    saving.value = false
  }
}

function normalize(event: Event): void {
  const field = event.currentTarget as HTMLInputElement
  draft.value = field.value.toUpperCase().replaceAll(/\s+/g, '')
  field.value = draft.value
  field.setCustomValidity(draft.value.length === 0 || props.pattern.test(draft.value) ? '' : props.hint)
}

function keydown(event: KeyboardEvent): void {
  if (event.isComposing)
    return
  if (event.key === 'Escape') {
    event.preventDefault()
    cancel()
  }
  else if (event.key === 'Enter') {
    event.preventDefault()
    void submit()
  }
}
</script>

<template>
  <div class="flex min-w-0 flex-col gap-1">
    <input ref="input" v-model="draft" lang="en" autocapitalize="characters" autocomplete="off" autocorrect="off" class="h-8 w-28 max-w-full min-w-0 rounded-md border border-slate-700 bg-slate-950 px-2.5 py-0 font-mono uppercase outline-none focus:border-cyan-500 disabled:opacity-50" inputmode="text" :pattern="pattern.source" :title="hint" :aria-label="`编辑${label}呼号`" :disabled="saving || disabled" spellcheck="false" @input="normalize" @keydown="keydown">
    <div class="flex gap-1 text-xs">
      <button type="button" :aria-label="`保存${label}呼号`" :disabled="saving || disabled" class="rounded border border-emerald-700 px-2 py-1 text-emerald-300 focus:outline-none disabled:opacity-50" @click="submit">
        {{ saving ? '保存中…' : '保存' }}
      </button>
      <button type="button" :aria-label="`取消编辑${label}呼号`" :disabled="saving || disabled" class="rounded border border-slate-700 px-2 py-1 text-slate-300 focus:outline-none disabled:opacity-50" @click="cancel">
        取消
      </button>
    </div>
  </div>
</template>
