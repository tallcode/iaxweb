import type { RecordingPlayback } from './types'
import { onBeforeUnmount, readonly, ref } from 'vue'

export function useRecordingPlayback(onError: (message: string) => void): RecordingPlayback {
  const playingRecordId = ref<string | null>(null)
  const audioPlayer = new Audio()
  let playbackVersion = 0
  audioPlayer.addEventListener('ended', stopPlayback)
  audioPlayer.addEventListener('error', handlePlaybackError)
  onBeforeUnmount(() => {
    stopPlayback()
    audioPlayer.removeEventListener('ended', stopPlayback)
    audioPlayer.removeEventListener('error', handlePlaybackError)
  })

  async function togglePlayback(id: string): Promise<void> {
    if (playingRecordId.value === id) {
      stopPlayback()
      return
    }
    stopPlayback()
    const version = ++playbackVersion
    playingRecordId.value = id
    audioPlayer.src = `/api/admin/records/${encodeURIComponent(id)}/audio`
    try {
      await audioPlayer.play()
    }
    catch {
      if (version === playbackVersion)
        handlePlaybackError()
    }
  }

  function stopPlayback(): void {
    ++playbackVersion
    audioPlayer.pause()
    audioPlayer.removeAttribute('src')
    audioPlayer.load()
    playingRecordId.value = null
  }

  function handlePlaybackError(): void {
    stopPlayback()
    onError('播放失败：录音可能已被清理')
  }

  return { playingRecordId: readonly(playingRecordId), togglePlayback, stopPlayback }
}
