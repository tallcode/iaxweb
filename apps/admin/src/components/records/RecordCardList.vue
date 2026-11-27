<script setup lang="ts">
import { useRecordRows } from '../../composables/records/use-record-rows'
import { formatRecordTime as formatTime } from '../../utils/records-format'
import RecognitionEditor from './RecognitionEditor.vue'
import RecordCallsign from './RecordCallsign.vue'
import RecordContextButton from './RecordContextButton.vue'
import RecordDuration from './RecordDuration.vue'
import ReviewStar from './ReviewStar.vue'
import SourceRepeater from './SourceRepeater.vue'
import SpeakerRecognitionButton from './SpeakerRecognitionButton.vue'

const { records, isFiltered, highlightedRecordId, showContext, isAdministrator, activeEditor, playingRecordId, togglePlayback, requestSpeakerRecognition, actionsDisabled, recognitionProps, callsignProps, reviewProps } = useRecordRows('card')
</script>

<template>
  <div class="space-y-3" :class="activeEditor?.view === 'card' ? 'block' : activeEditor?.view === 'table' ? 'hidden' : 'lg:hidden'">
    <article v-for="record in records" :key="record.id" :data-record-id="record.id" data-record-view="card" class="record-row-target rounded-xl border p-4 shadow-xl shadow-black/20" :class="highlightedRecordId === record.id ? 'record-context-highlight border-amber-200/40 bg-amber-200/15' : record.reviewed ? 'border-emerald-800/60 bg-emerald-950/40' : 'border-slate-800 bg-slate-900/70'">
      <div class="flex items-center justify-between gap-x-3" :class="isFiltered ? 'flex-wrap gap-y-2' : undefined">
        <div class="min-w-0">
          <p class="text-sm font-medium text-slate-200" :class="isFiltered ? 'whitespace-nowrap' : undefined">
            {{ formatTime(record.capturedAt) }}<RecordDuration :duration-ms="record.durationMs" :quality="record.audioQuality" class="ml-3 text-xs font-normal" />
          </p>
        </div><div class="ml-auto flex shrink-0 items-center gap-1">
          <button v-if="record.hasAudio" class="shrink-0 rounded-md border border-slate-700 px-3 py-1.5 text-xs transition hover:bg-slate-700" @click="togglePlayback(record.id)">
            {{ playingRecordId === record.id ? '停止' : '播放' }}
          </button><span v-else class="shrink-0 text-xs text-slate-600">已过期</span>
          <RecordContextButton v-if="isFiltered" :disabled="actionsDisabled()" @locate="showContext(record.id)" />
          <SpeakerRecognitionButton v-if="isAdministrator" :disabled="actionsDisabled()" @recognize="requestSpeakerRecognition(record)" />
          <ReviewStar v-if="isAdministrator" v-bind="reviewProps(record)" />
        </div>
      </div>
      <div class="mt-3">
        <RecognitionEditor v-bind="recognitionProps(record)" />
      </div>
      <div class="mt-4 flex gap-4 text-sm">
        <div class="flex min-w-0 flex-1 items-center gap-2 text-left">
          <span class="shrink-0 self-start text-xs leading-8 text-slate-500">来源</span><SourceRepeater :value="record.sourceRepeaterName ?? record.sourceRepeaterId" />
        </div>
        <div class="flex min-w-0 flex-1 items-center gap-2 text-left">
          <span class="shrink-0 self-start text-xs leading-8 text-slate-500">主叫</span><RecordCallsign v-bind="callsignProps(record, 'caller')" />
        </div>
      </div>
    </article>
  </div>
</template>
