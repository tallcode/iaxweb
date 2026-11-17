import type { PersistedRecord } from '@iaxweb/contracts'
import type { RecordDeletionController, RecordsFeedback } from './types'
import { readonly, ref } from 'vue'
import { ApiError, apiErrorMessage } from '../../api/client'
import { recordsApi } from '../../api/records'

interface DeletionOptions {
  canDelete: () => boolean
  onRequest: () => void
  onDeleted: (record: PersistedRecord) => Promise<void>
  onUnauthorized: () => Promise<void>
  feedback: RecordsFeedback
}

export function useRecordDeletion(options: DeletionOptions): RecordDeletionController {
  const pendingDeletion = ref<PersistedRecord | null>(null)
  const deletingRecordId = ref<string | null>(null)
  const error = ref('')

  function request(record: PersistedRecord): boolean {
    if (pendingDeletion.value || !options.canDelete())
      return false
    options.onRequest()
    error.value = ''
    pendingDeletion.value = record
    return true
  }
  function cancel(): boolean {
    if (deletingRecordId.value !== null)
      return false
    pendingDeletion.value = null
    error.value = ''
    return true
  }
  async function confirm(): Promise<boolean> {
    const record = pendingDeletion.value
    if (!record || deletingRecordId.value !== null || !options.canDelete())
      return false
    deletingRecordId.value = record.id
    error.value = ''
    options.onRequest()
    try {
      await recordsApi.delete(record.id)
      await options.onDeleted(record)
      pendingDeletion.value = null
      return true
    }
    catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        pendingDeletion.value = null
        await options.onUnauthorized()
      }
      else {
        error.value = apiErrorMessage(cause, '删除失败，请稍后重试')
        options.feedback.showError(error.value)
      }
      return false
    }
    finally {
      deletingRecordId.value = null
    }
  }

  return { state: { pendingDeletion: readonly(pendingDeletion), deletingRecordId: readonly(deletingRecordId), error: readonly(error) }, request, cancel, confirm }
}
