<script setup lang="ts">
import type { AudioQuality } from '@iaxweb/contracts'
import { computed } from 'vue'
import { audioInterferenceLabels } from '../../utils/records-format'

const props = defineProps<{ durationMs: number, quality?: AudioQuality | null | undefined }>()
const duration = computed(() => `${(props.durationMs / 1000).toFixed(1)}s`)
const reasons: Record<string, string> = {
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
const statusMessage = computed(() => {
  const quality = props.quality
  if (quality?.status === 'passed')
    return '语音质量良好'
  const code = quality?.reason
  const reason = code ? audioInterferenceLabels.get(code) ?? reasons[code] : undefined
  if (quality?.status === 'skip')
    return `历史记录，未重新检查语音质量${reason ? `；此前记录：${reason}` : ''}。`
  if (quality?.status === 'rejected')
    return `语音质量较差${reason ? `：${reason}` : ''}。`
  return reason ? `语音质量未知：${reason}。` : '暂无质量检查结果'
})
const message = computed(() => {
  const mains = props.quality?.metrics?.mainsDiagnostics
  if (!mains?.length)
    return statusMessage.value
  const frequencies = mains.map(({ fundamentalHz }) => `${fundamentalHz} Hz`).join('、')
  const status = statusMessage.value.replace(/。$/, '')
  return `${status}。观察到与 ${frequencies} 工频相符的谱线。`
})
</script>

<template>
  <span :title="message" :data-audio-quality="quality?.status ?? 'unknown'" class="whitespace-nowrap" :class="quality?.status === 'passed' ? 'text-white' : 'text-slate-500'">
    {{ duration }}
  </span>
</template>
