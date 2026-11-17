import type { PersistedRecord } from '@iaxweb/contracts'
import type { ActiveEditor, CallsignRole, EditorField, RecordEditingController, RecordsFeedback, RecordView } from './types'
import { computed, readonly, ref } from 'vue'
import { ApiError, apiErrorMessage } from '../../api/client'
import { recordsApi } from '../../api/records'

interface EditingOptions {
  canEdit: (record: PersistedRecord) => boolean
  isAdministrator: () => boolean
  canBegin: () => boolean
  canSave: () => boolean
  onBegin: () => void
  onSaved: (record: PersistedRecord) => Promise<void>
  onUnauthorized: () => Promise<void>
  onForbidden: () => Promise<void>
  feedback: RecordsFeedback
}

export function useRecordEditing(options: EditingOptions): RecordEditingController {
  const activeEditor = ref<ActiveEditor | null>(null)
  const saving = ref(new Set<string>())
  const hasActiveEditor = computed(() => activeEditor.value !== null)

  function acquireEditor(record: PersistedRecord, field: EditorField, view: RecordView): boolean {
    if (activeEditor.value || saving.value.size > 0 || !options.canEdit(record) || !options.canBegin())
      return false
    activeEditor.value = { id: record.id, field, view }
    options.onBegin()
    return true
  }

  function finishEditing(record: PersistedRecord, field: EditorField, view: RecordView): void {
    const current = activeEditor.value
    if (current?.id === record.id && current.field === field && current.view === view)
      activeEditor.value = null
  }

  function isEditingCallsign(record: PersistedRecord, role: CallsignRole, view: RecordView): boolean {
    const current = activeEditor.value
    return current?.id === record.id && current.field === role && current.view === view
  }

  async function save(record: PersistedRecord, operation: () => Promise<PersistedRecord>): Promise<boolean> {
    if (!options.canEdit(record) || saving.value.has(record.id) || !options.canSave())
      return false
    saving.value.add(record.id)
    options.onBegin()
    try {
      const updated = await operation()
      await options.onSaved(updated)
      options.feedback.showSummary()
      return true
    }
    catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        await options.onUnauthorized()
      }
      else {
        if (error instanceof ApiError && error.status === 403) {
          activeEditor.value = null
          await options.onForbidden()
        }
        options.feedback.showError(apiErrorMessage(error, error instanceof ApiError && error.status === 404 ? '保存失败：记录不存在' : '保存失败，请检查输入后重试'))
      }
      return false
    }
    finally {
      saving.value.delete(record.id)
    }
  }

  function saveRecognition(record: PersistedRecord, value: string | null): Promise<boolean> {
    return save(record, () => recordsApi.updateRecognition(record.id, value))
  }
  function saveCallsign(record: PersistedRecord, role: CallsignRole, value: string | null): Promise<boolean> {
    return save(record, () => role === 'callee' ? recordsApi.updateCalleeCallsign(record.id, value) : recordsApi.updateCallsign(record.id, value))
  }
  async function setReviewed(record: PersistedRecord, reviewed: boolean): Promise<void> {
    if (options.isAdministrator() && !activeEditor.value)
      await save(record, () => recordsApi.setReviewed(record.id, reviewed))
  }

  return {
    state: { activeEditor: readonly(activeEditor), hasActiveEditor, isSaving: computed(() => saving.value.size > 0) },
    isSaving: id => saving.value.has(id),
    acquireEditor,
    finishEditing,
    isEditingCallsign,
    saveRecognition,
    saveCallsign,
    setReviewed,
  }
}
