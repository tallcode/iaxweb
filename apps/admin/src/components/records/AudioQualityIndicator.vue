<script setup lang="ts">
import type { AudioQuality } from '@iaxweb/contracts'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps<{ quality?: AudioQuality | null | undefined }>()
const button = ref<HTMLButtonElement>()
const open = ref(false)
const position = ref({ top: '0px', left: '0px' })
const visible = computed(() => props.quality?.status !== 'passed' && props.quality?.status !== 'skip')
const rejected = computed(() => props.quality?.status === 'rejected')
const message = computed(() => rejected.value ? '语音质量较差' : '暂无质量检查结果')

function toggle(): void {
  const rect = button.value?.getBoundingClientRect()
  if (rect)
    position.value = { top: `${Math.min(rect.bottom + 6, window.innerHeight - 36)}px`, left: `${Math.max(8, Math.min(rect.left, window.innerWidth - 160))}px` }
  open.value = !open.value
}

function dismiss(event: Event): void {
  if (!button.value?.contains(event.target as Node))
    open.value = false
}
watch(() => props.quality, () => {
  open.value = false
})
onMounted(() => document.addEventListener('pointerdown', dismiss))
onBeforeUnmount(() => document.removeEventListener('pointerdown', dismiss))
</script>

<template>
  <button v-if="visible" ref="button" type="button" :title="message" :aria-label="message" :aria-expanded="open" class="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded focus:outline-none focus-visible:ring-1 focus-visible:ring-slate-400" :class="rejected ? 'text-amber-400' : 'text-slate-500'" @click.stop="toggle" @keydown.esc="open = false" @blur="open = false">
    <svg v-if="rejected" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="size-3.5" aria-hidden="true"><path d="m10.3 3.9-8 14a2 2 0 0 0 1.7 3h16a2 2 0 0 0 1.7-3l-8-14a2 2 0 0 0-3.4 0ZM12 9v4M12 17h.01" /></svg>
    <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="size-3.5" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01" /></svg>
  </button>
  <Teleport to="body">
    <div v-if="visible && open" role="tooltip" :style="position" class="pointer-events-none fixed z-[100] rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-200 shadow-lg">
      {{ message }}
    </div>
  </Teleport>
</template>
