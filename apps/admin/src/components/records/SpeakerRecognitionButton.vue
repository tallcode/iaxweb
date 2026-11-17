<script setup lang="ts">
defineProps<{ disabled: boolean }>()
const emit = defineEmits<{ recognize: [] }>()
</script>

<template>
  <button type="button" aria-label="声纹识别" title="声纹识别（测试）" :disabled="disabled" class="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-cyan-400 transition hover:bg-cyan-500/10 hover:text-cyan-300 focus:outline-none focus:ring-2 focus:ring-cyan-500/50 disabled:cursor-not-allowed disabled:opacity-40" @click="emit('recognize')">
    <!-- Lucide fingerprint-pattern (ISC): https://lucide.dev/icons/fingerprint-pattern -->
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="size-4" aria-hidden="true">
      <path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4" />
      <path d="M14 13.12c0 2.38 0 6.38-1 8.88" />
      <path d="M17.29 21.02c.12-.6.43-2.3.5-3.02" />
      <path d="M2 12a10 10 0 0 1 18-6" />
      <path d="M2 16h.01" />
      <path d="M21.8 16c.2-2 .131-5.354 0-6" />
      <path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2" />
      <path d="M8.65 22c.21-.66.45-1.32.57-2" />
      <path d="M9 6.8a6 6 0 0 1 9 5.2v2" />
    </svg>
  </button>
</template>
