import type { AdminSession, PersistedRecord } from '@iaxweb/contracts'
import type { SpotStore } from '../spots/spot-store.js'
import type { ReviewRepository } from './ports.js'
import type { ManualReviewPatch } from './record-repository.js'
import type { RecordingStore } from './recording-store.js'
import { hasCallerCallsign, NO_CALLSIGN, REVIEW_CALLSIGN_CLEAR_MESSAGE, REVIEW_CALLSIGN_REQUIRED_MESSAGE } from '@iaxweb/contracts'

export class RecordReviewError extends Error {
  constructor(readonly statusCode: 400 | 401 | 403 | 404, message: string) { super(message) }
}

export class RecordReviewService {
  constructor(
    private readonly repository: ReviewRepository,
    private readonly recordings: Pick<RecordingStore, 'remove'>,
    private readonly spots: Pick<SpotStore, 'publishReview'>,
  ) {}

  update(id: string, patch: ManualReviewPatch, user: AdminSession | undefined): PersistedRecord {
    if (!user)
      throw new RecordReviewError(401, 'Unauthorized')
    if (user.role !== 'admin' && user.role !== 'editor')
      throw new RecordReviewError(403, 'Forbidden')
    if (patch.reviewed !== undefined && user.role !== 'admin')
      throw new RecordReviewError(403, 'Forbidden')
    // Check the lock in the UPDATE, so annotation and editing remain atomic.
    if (!this.repository.updateManualReview(id, patch, user.role === 'admin')) {
      const existing = this.repository.find(id)
      if (!existing)
        throw new RecordReviewError(404, 'Not Found')
      if (user.role === 'admin' && (patch.reviewed === true || (existing.reviewed && patch.callsign !== undefined))
        && !hasCallerCallsign({ callsign: existing.callsign, manualCallsign: patch.callsign === undefined ? existing.manualCallsign : patch.callsign })) {
        throw new RecordReviewError(400, patch.reviewed === true ? REVIEW_CALLSIGN_REQUIRED_MESSAGE : REVIEW_CALLSIGN_CLEAR_MESSAGE)
      }
      throw new RecordReviewError(403, '记录已标注，只有管理员可以编辑')
    }
    const record = this.find(id)
    if (patch.callsign !== undefined)
      this.publish(record, record.effectiveCallsign ?? NO_CALLSIGN)
    return record
  }

  find(id: string): PersistedRecord {
    const record = this.repository.find(id)
    if (!record)
      throw new RecordReviewError(404, 'Not Found')
    return record
  }

  delete(id: string): void {
    const record = this.find(id)
    if (!this.repository.delete(id, () => this.recordings.remove(id, record.capturedAt)))
      throw new RecordReviewError(404, 'Not Found')
    this.publish(record, NO_CALLSIGN)
  }

  private publish(record: PersistedRecord, callsign: string): void {
    this.spots.publishReview({ at: record.capturedAt, callsign, id: record.id, node: record.nodeId })
  }
}
