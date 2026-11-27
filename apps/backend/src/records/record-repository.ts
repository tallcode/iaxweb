import type { AudioQuality, PersistedRecord, RadioSignal } from '@iaxweb/contracts'
import type { PublicRecordQueries, RecognitionRepository, RecordListRepository, SpeakerReferenceRepository } from './ports.js'
import type { ManualReviewPatch, PendingReviewedVoiceprint, ReadyVoiceprint, RecognitionRecord, RecordPage, SpeakerReferenceGroup, SpeakerSearchResult, SpeechHour, StoredSpot, Voiceprint } from './types.js'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SqlitePublicRecordQueries } from './sqlite/public-queries.js'
import { SqliteRecordStore } from './sqlite/record-store.js'
import { initializeRecordSchema } from './sqlite/schema.js'
import { SqliteSpeakerStore } from './sqlite/speaker-store.js'

export type { ManualReviewPatch, RecordPage, SpeechHour, StoredSpot } from './types.js'
export type { PersistedRecord } from '@iaxweb/contracts'

// Owns the connection shared by record writes, voiceprints and public queries.
export class RecordRepository implements RecognitionRepository, RecordListRepository, SpeakerReferenceRepository, PublicRecordQueries {
  private readonly database: DatabaseSync
  private readonly records: SqliteRecordStore
  private readonly speakers: SqliteSpeakerStore
  private readonly publicQueries: SqlitePublicRecordQueries

  constructor(databaseFile: string) {
    if (databaseFile !== ':memory:')
      mkdirSync(dirname(databaseFile), { recursive: true })
    this.database = new DatabaseSync(databaseFile, { timeout: 5_000, allowExtension: true })
    try {
      // Enable the native extension only while loading it on first use.
      this.database.enableLoadExtension(false)
      this.database.exec('PRAGMA journal_mode = WAL')
      this.database.exec('PRAGMA foreign_keys = ON')
      this.database.exec('BEGIN IMMEDIATE')
      initializeRecordSchema(this.database)
      this.database.exec('COMMIT')
    }
    catch (error) {
      // SQLite rolls back the unfinished initialization transaction on close.
      this.database.close()
      throw error
    }
    this.speakers = new SqliteSpeakerStore(this.database)
    this.records = new SqliteRecordStore(this.database, this.speakers)
    this.publicQueries = new SqlitePublicRecordQueries(this.database)
  }

  close(): void {
    this.database.close()
  }

  insert(nodeId: string, record: RecognitionRecord): void {
    this.records.insert(nodeId, record)
  }

  updateSignaling(id: string, signals: readonly RadioSignal[]): boolean {
    return this.records.updateSignaling(id, signals)
  }

  updateAutomaticCallsign(record: RecognitionRecord): boolean {
    return this.records.updateAutomaticCallsign(record)
  }

  updateManualReview(id: string, patch: ManualReviewPatch, allowReviewed?: boolean): boolean {
    return this.records.updateManualReview(id, patch, allowReviewed)
  }

  find(id: string): PersistedRecord | undefined {
    return this.records.find(id)
  }

  delete(id: string, removeRecording: () => void): boolean {
    return this.records.delete(id, removeRecording)
  }

  list(page: number, pageSize: number, callsign?: string, editedOnly?: boolean, reviewedOnly?: boolean): RecordPage {
    return this.records.list(page, pageSize, callsign, editedOnly, reviewedOnly)
  }

  listContaining(id: string, pageSize: number): RecordPage | undefined {
    return this.records.listContaining(id, pageSize)
  }

  updateVoiceprint(id: string, voiceprint: Voiceprint): boolean {
    return this.speakers.updateVoiceprint(id, voiceprint)
  }

  updateAudioQuality(id: string, quality: AudioQuality): boolean {
    return this.speakers.updateAudioQuality(id, quality)
  }

  findReadyVoiceprint(id: string): ReadyVoiceprint | undefined {
    return this.speakers.findReadyVoiceprint(id)
  }

  saveQueryVoiceprint(id: string, voiceprint: ReadyVoiceprint): void {
    this.speakers.saveQueryVoiceprint(id, voiceprint)
  }

  pendingReviewedVoiceprints(limit?: number): PendingReviewedVoiceprint[] {
    return this.speakers.pendingReviewedVoiceprints(limit)
  }

  prepareReviewedVoiceprint(id: string): boolean {
    return this.speakers.prepareReviewedVoiceprint(id)
  }

  searchSpeakerMatches(voiceprint: Voiceprint, excludeId: string): SpeakerSearchResult {
    return this.speakers.searchSpeakerMatches(voiceprint, excludeId)
  }

  recentSpeakerReferences(callsigns: string[], excludeId: string): SpeakerReferenceGroup[] {
    return this.speakers.recentSpeakerReferences(callsigns, excludeId)
  }

  speechHours(startAt: string, endAt: string): SpeechHour[] {
    return this.publicQueries.speechHours(startAt, endAt)
  }

  recentSpots(limit?: number): StoredSpot[] {
    return this.publicQueries.recentSpots(limit)
  }
}
