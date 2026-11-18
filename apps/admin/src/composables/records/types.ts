import type { AdminRecord, PersistedRecord, SpeakerRecognition } from '@iaxweb/contracts'
import type { DeepReadonly, Ref } from 'vue'

export type ReadonlyRef<T> = Readonly<Ref<T>>
export type CallsignRole = 'callee' | 'caller'
export type RecordView = 'card' | 'table'
export type EditorField = CallsignRole | 'recognition'
export interface ActiveEditor { id: string, field: EditorField, view: RecordView }
export type FeedbackKind = 'summary' | 'error' | 'success'

export interface RecordsFeedbackState {
  message: ReadonlyRef<string>
  kind: ReadonlyRef<FeedbackKind>
}
export interface RecordsFeedback {
  state: RecordsFeedbackState
  showError: (message: string) => void
  showSummary: () => void
  showSuccess: (message: string) => void
}

export interface RecordsQueryState {
  records: ReadonlyRef<readonly AdminRecord[]>
  currentPage: ReadonlyRef<number>
  pageInput: ReadonlyRef<string>
  pageCount: ReadonlyRef<number>
  total: ReadonlyRef<number>
  searchInput: ReadonlyRef<string>
  callsignFilter: ReadonlyRef<string>
  editedOnly: ReadonlyRef<boolean>
  reviewedOnly: ReadonlyRef<boolean>
  isLoading: ReadonlyRef<boolean>
  disabled: ReadonlyRef<boolean>
}
export interface RecordsQueryActions {
  setSearchInput: (value: string) => void
  setPageInput: (value: string) => void
  setEditedOnly: (value: boolean) => void
  setReviewedOnly: (value: boolean) => void
  searchCallsign: () => Promise<void>
  applyFilters: () => Promise<void>
  clearCallsignSearch: () => Promise<void>
  changePage: (page: number) => Promise<void>
  goToPage: () => Promise<void>
}
export interface RecordsQueryContext {
  state: RecordsQueryState
  actions: RecordsQueryActions
}
export interface RecordsQueryController extends RecordsQueryContext {
  summary: ReadonlyRef<string>
  reload: () => Promise<void>
  abort: () => void
  updateRecord: (record: PersistedRecord) => Promise<void>
  removeRecord: (id: string) => void
  clear: () => void
}

export interface RecordEditingState {
  activeEditor: ReadonlyRef<ActiveEditor | null>
  hasActiveEditor: ReadonlyRef<boolean>
  isSaving: ReadonlyRef<boolean>
}
export interface RecordEditingController {
  state: RecordEditingState
  isSaving: (id: string) => boolean
  acquireEditor: (record: PersistedRecord, field: EditorField, view: RecordView) => boolean
  finishEditing: (record: PersistedRecord, field: EditorField, view: RecordView) => void
  isEditingCallsign: (record: PersistedRecord, role: CallsignRole, view: RecordView) => boolean
  saveRecognition: (record: PersistedRecord, value: string | null) => Promise<boolean>
  saveCallsign: (record: PersistedRecord, role: CallsignRole, value: string | null) => Promise<boolean>
  setReviewed: (record: PersistedRecord, reviewed: boolean) => Promise<void>
}

export interface RecordingPlayback {
  playingRecordId: ReadonlyRef<string | null>
  togglePlayback: (id: string) => Promise<void>
  stopPlayback: () => void
}
export interface RecordDeletionState {
  pendingDeletion: ReadonlyRef<PersistedRecord | null>
  deletingRecordId: ReadonlyRef<string | null>
  error: ReadonlyRef<string>
}
export interface RecordDeletionContext {
  state: RecordDeletionState
  confirm: () => Promise<boolean>
  cancel: () => boolean
}
export interface RecordDeletionController extends RecordDeletionContext {
  request: (record: PersistedRecord) => boolean
}

export interface SpeakerRecognitionContext {
  state: {
    record: ReadonlyRef<PersistedRecord | null>
    loading: ReadonlyRef<boolean>
    result: ReadonlyRef<DeepReadonly<SpeakerRecognition> | null>
    error: ReadonlyRef<string>
  }
  request: (record: PersistedRecord) => void
  close: () => void
}

// Feature views can operate on records, but cannot access routing, pagination,
// logout, raw HTTP requests, or writable state owned by another controller.
export interface RecordInteractionsContext {
  isAdministrator: ReadonlyRef<boolean>
  activeEditor: ReadonlyRef<ActiveEditor | null>
  hasActiveEditor: ReadonlyRef<boolean>
  isMutating: ReadonlyRef<boolean>
  deletingRecordId: ReadonlyRef<string | null>
  playingRecordId: ReadonlyRef<string | null>
  canEditRecord: (record: PersistedRecord) => boolean
  isSaving: (id: string) => boolean
  acquireEditor: RecordEditingController['acquireEditor']
  finishEditing: RecordEditingController['finishEditing']
  isEditingCallsign: RecordEditingController['isEditingCallsign']
  saveRecognition: RecordEditingController['saveRecognition']
  saveCallsign: RecordEditingController['saveCallsign']
  setReviewed: RecordEditingController['setReviewed']
  togglePlayback: RecordingPlayback['togglePlayback']
  requestDeletion: RecordDeletionController['request']
  requestSpeakerRecognition: SpeakerRecognitionContext['request']
}
