import type { PersistedRecord } from '@iaxweb/contracts'
import { adminRecordPageSchema, manualCallsignSchema, manualRecognitionSchema, persistedRecordSchema, reviewSchema, speakerRecognitionSchema } from '@iaxweb/contracts'
import { CALLSIGN_HINT } from '../utils/callsign'
import { parseInput, request, requestJson } from './client'

export interface RecordsQuery {
  page: number
  pageSize: number
  recordId?: string
  callsign?: string
  editedOnly?: boolean
  reviewedOnly?: boolean
}

function recordUrl(id: string): string {
  return `/api/admin/records/${encodeURIComponent(id)}`
}

function update(id: string, field: string, body: unknown): Promise<PersistedRecord> {
  return requestJson(`${recordUrl(id)}/${field}`, persistedRecordSchema, { method: 'PATCH', body })
}

export const recordsApi = {
  list(query: RecordsQuery, signal?: AbortSignal) {
    const search = new URLSearchParams({ page: String(query.page), pageSize: String(query.pageSize) })
    if (query.recordId)
      search.set('recordId', query.recordId)
    else if (query.callsign)
      search.set('callsign', query.callsign)
    if (!query.recordId && query.editedOnly)
      search.set('editedOnly', 'true')
    if (!query.recordId && query.reviewedOnly)
      search.set('reviewedOnly', 'true')
    return requestJson(`/api/admin/records?${search}`, adminRecordPageSchema, { signal })
  },
  updateRecognition(id: string, recognition: string | null) {
    return update(id, 'manual-recognition', parseInput(manualRecognitionSchema, { recognition }, '识别文本应在 1000 字以内'))
  },
  updateCallsign(id: string, callsign: string | null) {
    return update(id, 'manual-callsign', parseInput(manualCallsignSchema, { callsign }, CALLSIGN_HINT))
  },
  updateCalleeCallsign(id: string, callsign: string | null) {
    return update(id, 'manual-callee-callsign', parseInput(manualCallsignSchema, { callsign }, CALLSIGN_HINT))
  },
  setReviewed(id: string, reviewed: boolean) {
    return update(id, 'manual-review', parseInput(reviewSchema, { reviewed }, '标注状态无效'))
  },
  recognizeSpeaker(id: string, signal?: AbortSignal) {
    return requestJson(`${recordUrl(id)}/speaker-recognition`, speakerRecognitionSchema, { method: 'POST', signal })
  },
  async delete(id: string): Promise<void> {
    await request(recordUrl(id), { method: 'DELETE', acceptedStatuses: [404] })
  },
}
