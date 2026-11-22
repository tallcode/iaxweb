import type { PersistedRecord } from '@iaxweb/contracts'
import type { RecordInteractionsContext } from './types'
import { computed, readonly, ref } from 'vue'
import { useRouter } from 'vue-router'
import { adminSession } from '../../admin-session'
import { apiErrorMessage } from '../../api/client'
import { sessionApi } from '../../api/session'
import { useRecordDeletion } from './use-record-deletion'
import { useRecordEditing } from './use-record-editing'
import { useRecordingPlayback } from './use-recording-playback'
import { useRecordsFeedback } from './use-records-feedback'
import { useRecordsQuery } from './use-records-query'
import { useSpeakerRecognition } from './use-speaker-recognition'

export function useRecordsPage(options: { onNavigate: () => void }) {
  const router = useRouter()
  const loggingOut = ref(false)
  const username = computed(() => adminSession.value?.username ?? '')
  const isAdministrator = computed(() => adminSession.value?.role === 'admin')
  const feedback = useRecordsFeedback(recordSummary)
  const query = useRecordsQuery({
    feedback,
    canChange,
    canAutoRefresh: canChange,
    onUnauthorized,
    onNavigate: options.onNavigate,
  })
  const playback = useRecordingPlayback(feedback.showError)
  const editing = useRecordEditing({
    feedback,
    canEdit: canEditRecord,
    isAdministrator: () => isAdministrator.value,
    canBegin: canBeginEditing,
    canSave,
    onBegin: query.abort,
    onSaved: query.updateRecord,
    onUnauthorized,
    onForbidden: query.reload,
  })
  const deletion = useRecordDeletion({
    feedback,
    canDelete: () => isAdministrator.value && !loggingOut.value && !editing.state.hasActiveEditor.value
      && !editing.state.isSaving.value && !query.state.isLoading.value,
    onRequest: query.abort,
    onUnauthorized,
    onDeleted: async (record) => {
      if (playback.playingRecordId.value === record.id)
        playback.stopPlayback()
      query.removeRecord(record.id)
      await query.reload()
    },
  })
  const isMutating = computed(() => editing.state.isSaving.value || deletion.state.deletingRecordId.value !== null)
  const speakerRecognition = useSpeakerRecognition({
    canBegin: () => isAdministrator.value && canChange() && !query.state.isLoading.value,
    onBegin: query.abort,
    onRecognized: query.reload,
    onUnauthorized,
  })
  const interactions: RecordInteractionsContext = {
    isAdministrator,
    activeEditor: editing.state.activeEditor,
    hasActiveEditor: editing.state.hasActiveEditor,
    isMutating,
    deletingRecordId: deletion.state.deletingRecordId,
    playingRecordId: playback.playingRecordId,
    canEditRecord,
    isSaving: editing.isSaving,
    acquireEditor: editing.acquireEditor,
    finishEditing: editing.finishEditing,
    isEditingCallsign: editing.isEditingCallsign,
    saveRecognition: editing.saveRecognition,
    saveCallsign: editing.saveCallsign,
    setReviewed: editing.setReviewed,
    togglePlayback: playback.togglePlayback,
    requestDeletion: deletion.request,
    requestSpeakerRecognition: speakerRecognition.request,
  }

  function recordSummary(): string {
    return query.summary.value
  }
  function canBeginEditing(): boolean {
    return !query.state.isLoading.value && !loggingOut.value && deletion.state.pendingDeletion.value === null && speakerRecognition.state.record.value === null
  }
  function canSave(): boolean {
    return !loggingOut.value && deletion.state.deletingRecordId.value === null
  }
  function canChange(): boolean {
    return !loggingOut.value && !editing.state.hasActiveEditor.value && !editing.state.isSaving.value
      && deletion.state.deletingRecordId.value === null && deletion.state.pendingDeletion.value === null
      && speakerRecognition.state.record.value === null
  }
  function canEditRecord(record: PersistedRecord): boolean {
    return isAdministrator.value || (adminSession.value?.role === 'editor' && !record.reviewed)
  }
  async function onUnauthorized(): Promise<void> {
    await router.replace('/')
  }
  async function logout(): Promise<void> {
    if (!canChange())
      return
    loggingOut.value = true
    query.abort()
    playback.stopPlayback()
    try {
      await sessionApi.logout()
      adminSession.value = null
      query.clear()
      await router.replace('/')
    }
    catch (error) {
      feedback.showError(apiErrorMessage(error, '注销失败，请重试'))
    }
    finally {
      loggingOut.value = false
    }
  }

  // Only these explicit view interfaces are provided to descendants. Controller
  // internals such as reload/abort/updateRecord remain owned by this coordinator.
  return {
    query: { state: query.state, actions: query.actions },
    interactions,
    deletion: { state: deletion.state, confirm: deletion.confirm, cancel: deletion.cancel },
    feedback: feedback.state,
    speakerRecognition,
    username,
    isAdministrator,
    loggingOut: readonly(loggingOut),
    controlsDisabled: computed(() => !canChange()),
    logout,
  }
}
