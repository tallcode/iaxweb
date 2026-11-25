<script setup lang="ts">
defineProps<{ value: string | null | undefined }>()
</script>

<template>
  <span
    class="inline-block min-w-0 max-w-full wrap-anywhere"
    :class="value ? 'rounded-md border border-sky-400/35 px-1.5 py-0.5 text-xs leading-4 font-medium text-sky-300' : 'text-slate-400'"
  >
    {{ value ?? '-' }}
  </span>
</template>
