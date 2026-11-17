import type { FeedbackKind, RecordsFeedback } from './types'
import { computed, ref } from 'vue'

export function useRecordsFeedback(summary: () => string): RecordsFeedback {
  const notice = ref<{ kind: Exclude<FeedbackKind, 'summary'>, message: string } | null>(null)
  return {
    state: {
      kind: computed(() => notice.value?.kind ?? 'summary'),
      message: computed(() => notice.value?.message ?? summary()),
    },
    showError: message => notice.value = { kind: 'error', message },
    showSuccess: message => notice.value = { kind: 'success', message },
    showSummary: () => notice.value = null,
  }
}
