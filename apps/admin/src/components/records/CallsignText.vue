<script setup lang="ts">
import { computed } from 'vue'
import TextDiff from './TextDiff.vue'

const props = defineProps<{ original: string | null, manual: string | null, algorithm?: string | null }>()
const tooltip = computed(() => {
  const algorithm = props.algorithm === 'stage1_text'
    ? '阶段 1'
    : props.algorithm === 'stage2_feature' ? '阶段 2' : props.algorithm ?? 'unknown'
  const lines = [`算法：${algorithm}`, `算法识别的呼号：${props.original ?? '（空）'}`]
  if (props.manual === 'N0CALL')
    lines.push('人工标注为 N0CALL：无有效主叫呼号')
  return lines.join('\n')
})
</script>

<template>
  <span :title="tooltip">
    <del v-if="manual === 'N0CALL'" class="rounded-sm bg-yellow-200/25 text-slate-100">{{ original ?? '—' }}</del>
    <span v-else-if="manual === null && original === null">—</span>
    <TextDiff v-else :original="original ?? ''" :manual="manual" hide-tooltip />
  </span>
</template>
