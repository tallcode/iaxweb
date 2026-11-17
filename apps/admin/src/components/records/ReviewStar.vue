<script setup lang="ts">
defineProps<{ reviewed: boolean, disabled: boolean }>()
const emit = defineEmits<{ toggle: [] }>()
</script>

<template>
  <button type="button" aria-label="标注记录" :aria-pressed="reviewed" :title="reviewed ? '取消标注' : '标注为已复核：识别文本、主叫和被叫均已人工复核'" :disabled="disabled" class="inline-flex size-8 shrink-0 items-center justify-center rounded-md transition hover:bg-emerald-500/10 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 disabled:cursor-not-allowed disabled:opacity-40" :class="reviewed ? 'text-emerald-400' : 'text-slate-400 hover:text-emerald-300'" @click="emit('toggle')">
    <svg viewBox="0 0 24 24" :fill="reviewed ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="size-4" aria-hidden="true"><path d="m12 3 2.78 5.63 6.22.91-4.5 4.38 1.06 6.19L12 17.19l-5.56 2.92 1.06-6.19L3 9.54l6.22-.91L12 3Z" /></svg>
  </button>
</template>
