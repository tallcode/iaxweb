import type { InjectionKey } from 'vue'
import type { RecordDeletionContext, RecordInteractionsContext, RecordsFeedbackState, RecordsQueryContext } from './types'
import { inject, provide } from 'vue'

const queryKey: InjectionKey<RecordsQueryContext> = Symbol('records-query')
const interactionsKey: InjectionKey<RecordInteractionsContext> = Symbol('record-interactions')
const deletionKey: InjectionKey<RecordDeletionContext> = Symbol('record-deletion')
const feedbackKey: InjectionKey<RecordsFeedbackState> = Symbol('records-feedback')

export function provideRecords(context: {
  query: RecordsQueryContext
  interactions: RecordInteractionsContext
  deletion: RecordDeletionContext
  feedback: RecordsFeedbackState
}): void {
  provide(queryKey, context.query)
  provide(interactionsKey, context.interactions)
  provide(deletionKey, context.deletion)
  provide(feedbackKey, context.feedback)
}

function required<T>(key: InjectionKey<T>): T {
  const value = inject(key)
  if (!value)
    throw new Error('Record components require their feature provider')
  return value
}
export const useRecordsQueryContext = (): RecordsQueryContext => required(queryKey)
export const useRecordInteractions = (): RecordInteractionsContext => required(interactionsKey)
export const useRecordDeletionContext = (): RecordDeletionContext => required(deletionKey)
export const useRecordsFeedbackContext = (): RecordsFeedbackState => required(feedbackKey)
