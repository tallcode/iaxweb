<script setup lang="ts">
defineProps<{ disabled: boolean }>()
const emit = defineEmits<{ locate: [] }>()
</script>

<template>
  <button type="button" aria-label="查看上下文" title="查看上下文" :disabled="disabled" class="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-amber-200 transition hover:bg-amber-200/10 hover:text-amber-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-200/50 disabled:cursor-not-allowed disabled:opacity-40" @click="emit('locate')">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="size-4" aria-hidden="true">
      <path d="M16 4h5M16 9h5M3 14h18M3 19h18M3 4l5 2.5L3 9z" />
    </svg>
  </button>
</template>
