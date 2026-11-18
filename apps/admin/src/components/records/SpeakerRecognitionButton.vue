<script setup lang="ts">
defineProps<{ disabled: boolean }>()
const emit = defineEmits<{ recognize: [] }>()
</script>

<template>
  <button type="button" aria-label="识别" title="识别" :disabled="disabled" class="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-cyan-400 transition hover:bg-cyan-500/10 hover:text-cyan-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/50 disabled:cursor-not-allowed disabled:opacity-40" @click="emit('recognize')">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="size-4" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.1 15.1 5.4 5.4" />
    </svg>
  </button>
</template>
