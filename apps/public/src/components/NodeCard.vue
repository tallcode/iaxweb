<script setup lang="ts">
import type { PublicNodeStatus, TransmitSource } from '@iaxweb/contracts'
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch, watchEffect } from 'vue'
import { audioPlayerKey, SpectrumMeter } from '../services/audio-player'

const props = defineProps<{
  isMobile: boolean
  node: PublicNodeStatus
  nodeId: string
}>()

const emit = defineEmits<{
  layoutChange: []
  register: [nodeId: string, element: HTMLElement | null]
}>()

const cardElement = ref<HTMLElement | null>(null)
const audioControlsElement = ref<HTMLElement | null>(null)
const audioPlayer = inject(audioPlayerKey)!
const isPlaying = computed(() => audioPlayer.playingNodeId === props.nodeId)
let collapseTimer: ReturnType<typeof setTimeout> | undefined
let pointerDownAt = 0
let activePointerId: number | undefined

const TAP_MAXIMUM_MS = 250
const TAP_VISIBLE_MINIMUM_MS = 2_000

const isHub = computed(() => props.node.TYPE === 'HUB')
const isOnline = computed(() => props.node.ONLINE === true)
const transmitSource = computed(() => isOnline.value && !isHub.value ? props.node.TX_SOURCE ?? null : null)
const hasAudio = computed(() => isHub.value && props.node.AUDIO === true)
const listenerCount = computed(() => Number.isInteger(props.node.LISTENERS) && (props.node.LISTENERS ?? 0) >= 0
  ? props.node.LISTENERS ?? 0
  : 0)
const isExpanded = ref(false)
const displayName = computed(() => props.isMobile && !isExpanded.value
  ? props.node.NAME || props.nodeId
  : props.node.DESC || props.node.NAME || props.nodeId)
const cardClasses = computed(() => [
  'node',
  isHub.value ? 'hub' : 'repeater',
  isOnline.value ? 'online' : 'offline',
  transmitSource.value ? `tx-${transmitSource.value}` : '',
  hasAudio.value ? 'has-audio' : '',
  isExpanded.value ? 'mobile-expanded' : '',
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
  clearCollapseTimer()
  emit('register', props.nodeId, null)
})

watch(audioControlsElement, (element, _, onCleanup) => {
  if (!element)
    return
  const meter = new SpectrumMeter(element)
  const stopWatching = watchEffect((onCleanup) => {
    if (props.isMobile || audioPlayer.playingNodeId !== props.nodeId)
      return
    const detach = audioPlayer.attachSpectrum(meter)
    if (detach)
      onCleanup(detach)
  })
  onCleanup(stopWatching)
}, { flush: 'post' })

function expandForTouch(event: PointerEvent): void {
  if (!props.isMobile || event.pointerType === 'mouse' || (event.target as HTMLElement).closest('button'))
    return

  clearCollapseTimer()
  if (!isExpanded.value) {
    setExpanded(true)
  }
  pointerDownAt = performance.now()
  activePointerId = event.pointerId
  const element = event.currentTarget as HTMLElement
  element.setPointerCapture?.(event.pointerId)
}

function deferCollapse(event: PointerEvent): void {
  if (!props.isMobile || !isExpanded.value || activePointerId !== event.pointerId)
    return
  const element = event.currentTarget as HTMLElement
  if (element.hasPointerCapture?.(event.pointerId))
    element.releasePointerCapture(event.pointerId)

  activePointerId = undefined
  const pressedFor = performance.now() - pointerDownAt
  if (pressedFor > TAP_MAXIMUM_MS) {
    setExpanded(false)
    return
  }

  // A tap gets a brief, readable preview; a held touch closes at release.
  collapseTimer = setTimeout(collapse, TAP_VISIBLE_MINIMUM_MS - pressedFor)
}

function clearCollapseTimer(): void {
  if (collapseTimer)
    clearTimeout(collapseTimer)
  collapseTimer = undefined
}

function collapse(): void {
  setExpanded(false)
  collapseTimer = undefined
}

function setExpanded(value: boolean): void {
  if (isExpanded.value === value)
    return
  isExpanded.value = value
  void nextTick(() => emit('layoutChange'))
}

function cancelTouch(event: PointerEvent): void {
  if (activePointerId !== event.pointerId)
    return
  activePointerId = undefined
  clearCollapseTimer()
  collapse()
}

async function toggleAudio(): Promise<void> {
  try {
    await audioPlayer.toggle(props.nodeId)
  }
  catch {
    // The player cleans up failed starts; an older failure must not stop a newer session.
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
  <article
    ref="cardElement"
    :class="cardClasses"
    :aria-expanded="isMobile ? isExpanded : undefined"
    :aria-label="ariaLabel"
    @pointercancel="cancelTouch"
    @pointerdown="expandForTouch"
    @pointerup="deferCollapse"
    @contextmenu.prevent
  >
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
      <div v-if="hasAudio" ref="audioControlsElement" class="node-audio" :class="{ 'is-playing': isPlaying }">
        <span class="listener-count" :title="`${listenerCount}人正在监听`" :aria-label="`${listenerCount}人正在监听`">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M16 11a4 4 0 1 0-3.45-6A4 4 0 0 0 16 11ZM8 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm8 1c-1.2 0-2.33.28-3.34.77A7.45 7.45 0 0 1 15.5 19v1H22v-1c0-3.31-2.69-6-6-6ZM8 14c-3.87 0-7 2.69-7 6h14c0-3.31-3.13-6-7-6Z" />
          </svg>
          <span>{{ listenerCount }}</span>
        </span>
        <div class="spectrum" aria-hidden="true" />
        <button
          class="audio-toggle"
          type="button"
          :aria-label="isPlaying ? '停止播放' : '播放音频'"
          :aria-pressed="isPlaying"
          @click="toggleAudio"
        >
          {{ isPlaying ? '■' : '▶' }}
        </button>
      </div>
    </div>
  </article>
</template>

<style src="./NodeCard.css"></style>
