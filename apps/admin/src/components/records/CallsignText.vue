<script setup lang="ts">
import TextDiff from './TextDiff.vue'

defineProps<{ original: string | null, manual: string | null }>()
</script>

<template>
  <del v-if="manual === 'N0CALL'" class="rounded-sm bg-yellow-200/25 text-slate-100" title="人工标注为 N0CALL：无有效主叫呼号">{{ original ?? '—' }}</del>
  <TextDiff v-else :original="original ?? ''" :manual="manual" /><span v-if="manual === null && original === null">—</span>
</template>
