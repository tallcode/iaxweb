import type { PersistedRecord, SpeakerRecognition } from '@iaxweb/contracts'
import type { SpeakerRecognitionContext } from './types'
import { onScopeDispose, readonly, ref } from 'vue'
import { ApiError, apiErrorMessage } from '../../api/client'
import { recordsApi } from '../../api/records'

export function useSpeakerRecognition(options: { canBegin: () => boolean, onBegin: () => void, onUnauthorized: () => Promise<void> }): SpeakerRecognitionContext {
  const record = ref<PersistedRecord | null>(null)
  const loading = ref(false)
  const result = ref<SpeakerRecognition | null>(null)
  const error = ref('')
  let controller: AbortController | undefined
  let sequence = 0

  async function recognize(): Promise<void> {
    if (!record.value || loading.value)
      return
    const id = record.value.id
    const current = ++sequence
    controller = new AbortController()
    loading.value = true
    error.value = ''
    result.value = null
    try {
      const response = await recordsApi.recognizeSpeaker(id, controller.signal)
      if (current === sequence)
        result.value = response
    }
    catch (cause) {
      if (current !== sequence || (cause instanceof ApiError && cause.kind === 'aborted'))
        return
      error.value = apiErrorMessage(cause, '声纹测试失败，请重试')
      if (cause instanceof ApiError && cause.status === 401)
        await options.onUnauthorized()
    }
    finally {
      if (current === sequence)
        loading.value = false
    }
  }

  function request(value: PersistedRecord): void {
    if (!options.canBegin() || record.value)
      return
    options.onBegin()
    record.value = value
    void recognize()
  }
  function close(): void {
    sequence++
    controller?.abort()
    record.value = null
    result.value = null
    error.value = ''
    loading.value = false
  }
  onScopeDispose(close)
  function retry(): void {
    void recognize()
  }
  return { state: { record: readonly(record), loading: readonly(loading), result: readonly(result), error: readonly(error) }, request, retry, close }
}
