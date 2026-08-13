<script setup lang="ts">
import type { PublicNodeStatus, TransmitSource } from '@iaxweb/contracts'
import type { AudioStreamPlayer } from '../services/audio-player'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { SpectrumMeter } from '../services/audio-player'

const props = defineProps<{
  isMobile: boolean
  node: PublicNodeStatus
  nodeId: string
  audioPlayer: AudioStreamPlayer
}>()

const emit = defineEmits<{
  register: [nodeId: string, element: HTMLElement | null]
}>()

const cardElement = ref<HTMLElement | null>(null)
const audioControlsElement = ref<HTMLElement | null>(null)
const audioButton = ref<HTMLButtonElement | null>(null)
let spectrumMeter: SpectrumMeter | undefined

const isHub = computed(() => props.node.TYPE === 'HUB')
const isOnline = computed(() => props.node.ONLINE === true)
const transmitSource = computed(() => isOnline.value && !isHub.value ? props.node.TX_SOURCE ?? null : null)
const hasAudio = computed(() => isHub.value && props.node.AUDIO === true)
const listenerCount = computed(() => Number.isInteger(props.node.LISTENERS) && (props.node.LISTENERS ?? 0) >= 0
  ? props.node.LISTENERS ?? 0
  : 0)
const displayName = computed(() => props.isMobile
  ? props.node.NAME || props.nodeId
  : props.node.DESC || props.node.NAME || props.nodeId)
const cardClasses = computed(() => [
  'node',
  isHub.value ? 'hub' : 'repeater',
  isOnline.value ? 'online' : 'offline',
  transmitSource.value ? `tx-${transmitSource.value}` : '',
  hasAudio.value ? 'has-audio' : '',
])
const ariaLabel = computed(() => isHub.value
  ? `${props.nodeId} ${displayName.value}，HUB，${isOnline.value ? '在线' : '离线'}${hasAudio.value ? `，${listenerCount.value}人正在监听` : ''}`
  : `${props.nodeId} ${displayName.value}，${isOnline.value ? '在线' : '离线'}${transmitSource.value ? `，${transmitLabel(transmitSource.value)}` : ''}`)

const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  month: '2-digit',
  second: '2-digit',
})

onMounted(() => emit('register', props.nodeId, cardElement.value))
onBeforeUnmount(() => {
  emit('register', props.nodeId, null)
  spectrumMeter?.detach()
  if (props.audioPlayer.playingNodeId === props.nodeId)
    void props.audioPlayer.stop()
})

async function toggleAudio(): Promise<void> {
  if (!audioControlsElement.value || !audioButton.value)
    return
  spectrumMeter ??= new SpectrumMeter(audioControlsElement.value, { enabled: () => !props.isMobile })
  try {
    await props.audioPlayer.toggle(props.nodeId, audioButton.value, spectrumMeter, { play: '▶', stop: '■' })
  }
  catch {
    await props.audioPlayer.stop()
  }
}

function transmitLabel(value: TransmitSource): string {
  if (value === 'local')
    return '本地发射'
  if (value === 'remote')
    return '远程发射'
  if (value === 'system')
    return '系统发射'
  return ''
}
</script>

<template>
  <article ref="cardElement" :class="cardClasses" :aria-label="ariaLabel">
    <p class="node-name">
      {{ displayName }}
    </p>
    <div class="node-footer">
      <div class="node-details">
        <div class="node-meta">
          <span v-if="isHub" class="node-kind">HUB</span>
          <span v-else class="node-frequency">{{ node.FREQ || '频率未配置' }}</span>
        </div>
        <div class="node-status">
          <span class="node-state">
            <span v-if="!transmitSource" class="online-label">
              <i class="dot" :class="isOnline ? 'online' : 'offline'" />
              <span>{{ isOnline ? '在线' : '离线' }}</span>
            </span>
            <span v-else class="tx-label">{{ transmitLabel(transmitSource) }}</span>
          </span>
          <time v-if="!isHub && !transmitSource" :datetime="node.LAST_TX_AT || ''">
            {{ node.LAST_TX_AT ? `上次 ${timeFormatter.format(new Date(node.LAST_TX_AT))}` : '暂无发射记录' }}
          </time>
        </div>
      </div>
      <div v-if="hasAudio" ref="audioControlsElement" class="node-audio">
        <span class="listener-count" :title="`${listenerCount}人正在监听`" :aria-label="`${listenerCount}人正在监听`">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M16 11a4 4 0 1 0-3.45-6A4 4 0 0 0 16 11ZM8 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm8 1c-1.2 0-2.33.28-3.34.77A7.45 7.45 0 0 1 15.5 19v1H22v-1c0-3.31-2.69-6-6-6ZM8 14c-3.87 0-7 2.69-7 6h14c0-3.31-3.13-6-7-6Z" />
          </svg>
          <span>{{ listenerCount }}</span>
        </span>
        <div class="spectrum" aria-hidden="true" />
        <button ref="audioButton" class="audio-toggle" type="button" aria-label="播放音频" aria-pressed="false" @click="toggleAudio">
          ▶
        </button>
      </div>
    </div>
  </article>
</template>
