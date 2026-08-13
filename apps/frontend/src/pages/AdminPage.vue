<script setup lang="ts">
import type { PersistedSegment, SegmentPage } from '@iaxweb/contracts'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

const PAGE_SIZE = 50
const authenticated = ref<boolean | null>(null)
const username = ref('')
const password = ref('')
const loginError = ref('')
const statusMessage = ref('')
const segments = ref<PersistedSegment[]>([])
const currentPage = ref(1)
const total = ref(0)
const playingSegmentId = ref<string | null>(null)
const audioPlayer = new Audio()

const pageCount = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))

audioPlayer.addEventListener('ended', stopPlayback)
audioPlayer.addEventListener('error', handlePlaybackError)
onMounted(() => void loadSegments())
onBeforeUnmount(() => {
  stopPlayback()
  audioPlayer.removeEventListener('ended', stopPlayback)
  audioPlayer.removeEventListener('error', handlePlaybackError)
})

async function login(): Promise<void> {
  const response = await fetch('/api/admin/login', {
    body: JSON.stringify({ password: password.value, username: username.value }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  if (!response.ok) {
    loginError.value = '用户名或密码错误'
    return
  }
  loginError.value = ''
  authenticated.value = true
  password.value = ''
  await loadSegments()
}

async function logout(): Promise<void> {
  await fetch('/api/admin/logout', { method: 'POST' })
  stopPlayback()
  segments.value = []
  authenticated.value = false
  username.value = ''
  password.value = ''
}

async function loadSegments(): Promise<void> {
  statusMessage.value = '加载中…'
  const response = await fetch(`/api/admin/segments?page=${currentPage.value}&pageSize=${PAGE_SIZE}`)
  if (response.status === 401) {
    authenticated.value = false
    statusMessage.value = ''
    return
  }
  if (!response.ok) {
    authenticated.value = response.status === 503 ? null : authenticated.value
    statusMessage.value = response.status === 503 ? '持久化未启用' : '加载失败'
    return
  }
  const data = await response.json() as SegmentPage
  authenticated.value = true
  total.value = data.total
  segments.value = data.items
  statusMessage.value = total.value === 0 ? '暂无记录' : `共 ${total.value} 条记录`
}

async function changePage(nextPage: number): Promise<void> {
  currentPage.value = nextPage
  await loadSegments()
}

async function togglePlayback(id: string): Promise<void> {
  if (playingSegmentId.value === id) {
    stopPlayback()
    return
  }
  stopPlayback()
  playingSegmentId.value = id
  audioPlayer.src = `/api/admin/segments/${encodeURIComponent(id)}/audio`
  try {
    await audioPlayer.play()
  }
  catch {
    handlePlaybackError()
  }
}

function stopPlayback(): void {
  audioPlayer.pause()
  audioPlayer.removeAttribute('src')
  audioPlayer.load()
  playingSegmentId.value = null
}

function handlePlaybackError(): void {
  stopPlayback()
  statusMessage.value = '播放失败：录音可能已被清理'
}

function canPlay(capturedAt: string): boolean {
  const ageMs = Date.now() - new Date(capturedAt).getTime()
  return ageMs >= 0 && ageMs < 30 * 24 * 60 * 60 * 1_000
}

async function saveCallsign(segment: PersistedSegment, input: HTMLInputElement): Promise<void> {
  const callsign = input.value.trim().toUpperCase()
  const response = await fetch(`/api/admin/segments/${encodeURIComponent(segment.id)}/manual-callsign`, {
    body: JSON.stringify({ callsign: callsign || null }),
    headers: { 'content-type': 'application/json' },
    method: 'PATCH',
  })
  if (!response.ok) {
    statusMessage.value = '保存失败：呼号必须是规范呼号或 N0CALL'
    input.value = segment.manualCallsign ?? ''
    return
  }
  segment.manualCallsign = callsign || null
  input.value = callsign
  statusMessage.value = '已保存'
}

function onCallsignKeydown(event: KeyboardEvent, segment: PersistedSegment): void {
  if (event.key !== 'Enter')
    return
  event.preventDefault()
  void saveCallsign(segment, event.currentTarget as HTMLInputElement)
}

function formatTime(iso: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'short',
    timeStyle: 'medium',
    timeZone: 'Asia/Shanghai',
  }).format(new Date(iso))
}
</script>

<template>
  <main class="min-h-dvh bg-slate-950 px-4 py-10 text-slate-100 sm:px-6 lg:px-8">
    <section v-if="authenticated === false" class="mx-auto max-w-md rounded-2xl border border-slate-800 bg-slate-900/80 p-7 shadow-2xl shadow-black/30 backdrop-blur">
      <h1 class="mb-6 text-2xl font-semibold tracking-tight">
        管理登录
      </h1>
      <form class="space-y-5" @submit.prevent="login">
        <label class="block space-y-2 text-sm text-slate-300">
          <span>用户名</span>
          <input v-model="username" autocomplete="username" required class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/20">
        </label>
        <label class="block space-y-2 text-sm text-slate-300">
          <span>密码</span>
          <input v-model="password" type="password" autocomplete="current-password" required class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/20">
        </label>
        <p v-if="loginError" class="text-sm text-red-400">
          {{ loginError }}
        </p>
        <button class="w-full rounded-lg bg-cyan-600 px-4 py-2.5 font-medium text-white transition hover:bg-cyan-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400">
          登录
        </button>
      </form>
    </section>

    <section v-else-if="authenticated === true" class="mx-auto max-w-screen-2xl">
      <header class="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 class="text-2xl font-semibold tracking-tight">
            AI 识别记录
          </h1>
          <p class="mt-1 text-sm text-slate-400">
            {{ statusMessage }}
          </p>
        </div>
        <button class="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 transition hover:border-slate-500 hover:bg-slate-800" @click="logout">
          退出
        </button>
      </header>

      <div class="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/70 shadow-xl shadow-black/20">
        <table class="min-w-full divide-y divide-slate-800 text-left text-sm">
          <thead class="bg-slate-900 text-xs uppercase tracking-wide text-slate-400">
            <tr>
              <th class="px-4 py-3">
                时间
              </th><th class="px-4 py-3">
                时长
              </th><th class="px-4 py-3">
                识别文本
              </th><th class="px-4 py-3">
                AI 呼号
              </th><th class="px-4 py-3">
                人工复核呼号
              </th><th class="px-4 py-3">
                播放
              </th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-800/80">
            <tr v-for="segment in segments" :key="segment.id" class="align-top transition hover:bg-slate-800/40">
              <td class="whitespace-nowrap px-4 py-3 text-slate-400">
                {{ formatTime(segment.capturedAt) }}
              </td>
              <td class="whitespace-nowrap px-4 py-3">
                {{ (segment.durationMs / 1_000).toFixed(1) }}s
              </td>
              <td class="min-w-80 px-4 py-3 leading-6">
                {{ segment.recognition }}
              </td>
              <td class="whitespace-nowrap px-4 py-3 font-mono text-cyan-300">
                {{ segment.callsign ?? '' }}
              </td>
              <td class="px-4 py-3">
                <input
                  :value="segment.manualCallsign ?? ''"
                  class="w-32 rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 font-mono uppercase outline-none focus:border-cyan-500"
                  aria-label="人工复核呼号"
                  @blur="($event.currentTarget as HTMLInputElement).value = segment.manualCallsign ?? ''"
                  @keydown="onCallsignKeydown($event, segment)"
                >
              </td>
              <td class="px-4 py-3">
                <button v-if="canPlay(segment.capturedAt)" class="rounded-md border border-slate-700 px-3 py-1.5 text-xs transition hover:bg-slate-700" @click="togglePlayback(segment.id)">
                  {{ playingSegmentId === segment.id ? '停止' : '播放' }}
                </button>
                <span v-else class="text-xs text-slate-600">已过期</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <nav class="mt-5 flex items-center justify-center gap-4 text-sm">
        <button :disabled="currentPage <= 1" class="rounded-lg border border-slate-700 px-4 py-2 disabled:cursor-not-allowed disabled:opacity-40" @click="changePage(currentPage - 1)">
          上一页
        </button>
        <span class="text-slate-400">第 {{ currentPage }} 页 / {{ pageCount }} 页</span>
        <button :disabled="currentPage >= pageCount" class="rounded-lg border border-slate-700 px-4 py-2 disabled:cursor-not-allowed disabled:opacity-40" @click="changePage(currentPage + 1)">
          下一页
        </button>
      </nav>
    </section>

    <p v-else class="mx-auto max-w-md rounded-xl border border-slate-800 bg-slate-900 p-5 text-center text-slate-400">
      {{ statusMessage || '正在检查服务状态…' }}
    </p>
  </main>
</template>
