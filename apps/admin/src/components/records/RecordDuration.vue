<script setup lang="ts">
import type { AudioQuality } from '@iaxweb/contracts'
import { computed } from 'vue'

const props = defineProps<{ durationMs: number, quality?: AudioQuality | null | undefined }>()
const duration = computed(() => `${(props.durationMs / 1000).toFixed(1)}s`)
const reasons: Record<string, string> = {
  interference_tone: '存在明显的持续单音',
  interference_high_band: '高频噪声较明显',
  invalid_audio: '音频数据无效',
  insufficient_audio: '有效音频不足或没有可用声音',
  check_timeout: '检查超时，可手动重试',
  check_failed: '检查失败，可手动重试',
  check_cancelled: '检查已取消，可手动重试',
  check_busy: '检查任务繁忙，可手动重试',
  check_audio_too_long: '音频过长，未完成检查',
  recording_missing: '录音文件不存在或已过期',
  recording_invalid: '录音文件无法读取或格式无效',
}
const message = computed(() => {
  const quality = props.quality
  if (quality?.status === 'passed')
    return '语音质量良好'
  const reason = quality?.reason ? reasons[quality.reason] : undefined
  if (quality?.status === 'skip')
    return `历史记录，未重新检查语音质量${reason ? `；此前记录：${reason}` : ''}。`
  if (quality?.status === 'rejected')
    return `语音质量较差${reason ? `：${reason}` : ''}。`
  return reason ? `语音质量未知：${reason}。` : '暂无质量检查结果'
})
</script>

<template>
  <span :title="message" :data-audio-quality="quality?.status ?? 'unknown'" class="whitespace-nowrap" :class="quality?.status === 'passed' ? 'text-white' : 'text-slate-500'">
    {{ duration }}
  </span>
</template>
