<script setup lang="ts">
defineProps<{
  title: string
  username: string
  loggingOut: boolean
  disabled?: boolean
}>()
const emit = defineEmits<{ logout: [] }>()
</script>

<template>
  <header class="fixed inset-x-0 top-0 z-30 h-16 whitespace-nowrap border-b border-slate-800 bg-slate-950">
    <div class="mx-auto flex h-full max-w-screen-2xl items-center justify-between gap-3 px-4 sm:gap-4 sm:px-6 lg:px-8">
      <h1 class="shrink-0 text-lg font-semibold tracking-tight">
        {{ title }}
      </h1>
      <nav class="flex min-w-0 flex-1 items-center justify-start" aria-label="管理导航">
        <slot />
      </nav>
      <div class="flex min-w-0 items-center gap-2 sm:gap-4">
        <span class="truncate font-mono text-sm text-slate-300" :title="username" aria-label="当前用户">{{ username || '—' }}</span>
        <button type="button" :disabled="loggingOut || disabled" class="shrink-0 rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 transition hover:border-slate-500 hover:bg-slate-800 focus:outline-none disabled:cursor-wait disabled:opacity-50" @click="emit('logout')">
          {{ loggingOut ? '注销中…' : '注销' }}
        </button>
      </div>
    </div>
  </header>
</template>
