import type { PersistedRecord } from '@iaxweb/contracts'
import type { CallsignRole, RecordView } from './types'
import { hasCallerCallsign } from '@iaxweb/contracts'
import { useRecordInteractions, useRecordsQueryContext } from './use-records-context'

export function useRecordRows(view: RecordView) {
  const query = useRecordsQueryContext()
  const { records, isLoading, isFiltered, highlightedRecordId } = query.state
  const actions = useRecordInteractions()

  function actionsDisabled(): boolean {
    return isLoading.value || actions.isMutating.value || actions.hasActiveEditor.value
  }

  function recognitionProps(record: PersistedRecord) {
    return {
      signals: record.signaling,
      original: record.recognition,
      manual: record.manualRecognition,
      readOnly: !actions.canEditRecord(record),
      disabled: actionsDisabled(),
      save: (value: string | null) => actions.saveRecognition(record, value),
      requestEdit: () => actions.acquireEditor(record, 'recognition', view),
      onEditing: (editing: boolean) => {
        if (!editing)
          actions.finishEditing(record, 'recognition', view)
      },
    }
  }

  function callsignProps(record: PersistedRecord, role: CallsignRole) {
    return {
      record,
      role,
      editing: actions.isEditingCallsign(record, role, view),
      disabled: actionsDisabled() || !actions.canEditRecord(record),
      saving: actions.isSaving(record.id),
      save: (value: string | null) => actions.saveCallsign(record, role, value),
      onBegin: () => actions.acquireEditor(record, role, view),
      onClose: () => actions.finishEditing(record, role, view),
    }
  }

  function reviewProps(record: PersistedRecord) {
    return {
      reviewed: record.reviewed,
      hasCaller: hasCallerCallsign(record),
      disabled: actionsDisabled(),
      onToggle: () => actions.setReviewed(record, !record.reviewed),
    }
  }

  return {
    records,
    isFiltered,
    highlightedRecordId,
    showContext: query.actions.showContext,
    isAdministrator: actions.isAdministrator,
    activeEditor: actions.activeEditor,
    playingRecordId: actions.playingRecordId,
    togglePlayback: actions.togglePlayback,
    requestSpeakerRecognition: actions.requestSpeakerRecognition,
    requestDeletion: actions.requestDeletion,
    actionsDisabled,
    recognitionProps,
    callsignProps,
    reviewProps,
  }
}
