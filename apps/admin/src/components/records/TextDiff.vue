<script setup lang="ts">
import { computed } from 'vue'
import { textDiff } from '../../utils/text-diff'

const props = defineProps<{ original: string, manual: string | null }>()
const parts = computed(() => props.manual === null ? [{ text: props.original, changed: false }] : textDiff(props.original, props.manual))
</script>

<template>
  <span :title="manual !== null ? `AI 识别：${original || '（空）'}` : undefined"><span v-for="(part, index) in parts" :key="index" :class="part.changed ? 'rounded-sm bg-yellow-200/25' : undefined">{{ part.text }}</span></span>
</template>
