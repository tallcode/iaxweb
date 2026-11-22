<script setup lang="ts">
import { hasCallerCallsign } from '@iaxweb/contracts'
import { useRecordInteractions, useRecordsQueryContext } from '../../composables/records/use-records-context'
import { formatRecordTime as formatTime } from '../../utils/records-format'
import AudioQualityIndicator from './AudioQualityIndicator.vue'
import RecognitionEditor from './RecognitionEditor.vue'
import RecordCallsign from './RecordCallsign.vue'
import ReviewStar from './ReviewStar.vue'
import SpeakerRecognitionButton from './SpeakerRecognitionButton.vue'

const { records, isLoading } = useRecordsQueryContext().state
const { isAdministrator, activeEditor, hasActiveEditor, isMutating, canEditRecord, isSaving, togglePlayback, requestSpeakerRecognition, acquireEditor, finishEditing, isEditingCallsign, saveRecognition, saveCallsign, setReviewed, playingRecordId } = useRecordInteractions()
</script>

<template>
  <div class="space-y-3" :class="activeEditor?.view === 'card' ? 'block' : activeEditor?.view === 'table' ? 'hidden' : 'lg:hidden'">
    <article v-for="record in records" :key="record.id" class="rounded-xl border p-4 shadow-xl shadow-black/20" :class="record.reviewed ? 'border-emerald-800/60 bg-emerald-950/40' : 'border-slate-800 bg-slate-900/70'">
      <div class="flex items-center justify-between gap-3">
        <div class="min-w-0">
          <p class="text-sm font-medium text-slate-200">
            {{ formatTime(record.capturedAt) }}<span class="ml-3 inline-flex items-center gap-1 whitespace-nowrap align-middle text-xs font-normal text-slate-500"><span>{{ (record.durationMs / 1_000).toFixed(1) }}s</span><AudioQualityIndicator :quality="record.audioQuality" /></span>
          </p>
        </div><div class="flex shrink-0 items-center gap-1">
          <button v-if="record.hasAudio" class="shrink-0 rounded-md border border-slate-700 px-3 py-1.5 text-xs transition hover:bg-slate-700" @click="togglePlayback(record.id)">
            {{ playingRecordId === record.id ? '停止' : '播放' }}
          </button><span v-else class="shrink-0 text-xs text-slate-600">已过期</span>
          <SpeakerRecognitionButton v-if="isAdministrator" :disabled="isLoading || isSaving(record.id) || isMutating || hasActiveEditor" @recognize="requestSpeakerRecognition(record)" />
          <ReviewStar v-if="isAdministrator" :reviewed="record.reviewed" :has-caller="hasCallerCallsign(record)" :disabled="isSaving(record.id) || isMutating || hasActiveEditor" @toggle="setReviewed(record, !record.reviewed)" />
        </div>
      </div>
      <div class="mt-3">
        <RecognitionEditor :signals="record.signaling" :original="record.recognition" :manual="record.manualRecognition" :read-only="!canEditRecord(record)" :disabled="hasActiveEditor || isSaving(record.id) || isMutating" :save="value => saveRecognition(record, value)" :request-edit="() => acquireEditor(record, 'recognition', 'card')" @editing="editing => !editing && finishEditing(record, 'recognition', 'card')" />
      </div>
      <div class="mt-4 flex gap-4 text-sm">
        <div class="flex min-w-0 flex-1 items-center gap-2 text-left">
          <span class="shrink-0 self-start text-xs leading-8 text-slate-500">被叫</span><RecordCallsign :record="record" role="callee" :editing="isEditingCallsign(record, 'callee', 'card')" :disabled="hasActiveEditor || !canEditRecord(record) || isMutating" :saving="isSaving(record.id)" :save="value => saveCallsign(record, 'callee', value)" @begin="acquireEditor(record, 'callee', 'card')" @close="finishEditing(record, 'callee', 'card')" />
        </div>
        <div class="flex min-w-0 flex-1 items-center gap-2 text-left">
          <span class="shrink-0 self-start text-xs leading-8 text-slate-500">主叫</span><RecordCallsign :record="record" role="caller" :editing="isEditingCallsign(record, 'caller', 'card')" :disabled="hasActiveEditor || !canEditRecord(record) || isMutating" :saving="isSaving(record.id)" :save="value => saveCallsign(record, 'caller', value)" @begin="acquireEditor(record, 'caller', 'card')" @close="finishEditing(record, 'caller', 'card')" />
        </div>
      </div>
    </article>
  </div>
</template>
