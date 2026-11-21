<script setup lang="ts">
import type { RadioSignal } from '@iaxweb/contracts'
import { computed } from 'vue'

const props = defineProps<{ signals?: readonly RadioSignal[] | null | undefined }>()
const tooltip = computed(() => props.signals?.map(signal => `${signal.type}\n${signal.content}`).join('\n\n'))
</script>

<template>
  <span v-if="signals?.length" :title="tooltip" :aria-label="tooltip" role="img" class="ml-1 inline-flex cursor-help align-middle text-cyan-400" @click.stop>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="size-4" aria-hidden="true"><path d="M2 12h2l3-8 4 16 4-16 3 8h4" /></svg>
  </span>
</template>
