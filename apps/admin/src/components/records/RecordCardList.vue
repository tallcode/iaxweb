<script setup lang="ts">
import { useRecordRows } from '../../composables/records/use-record-rows'
import { formatRecordTime as formatTime } from '../../utils/records-format'
import RecognitionEditor from './RecognitionEditor.vue'
import RecordCallsign from './RecordCallsign.vue'
import RecordDuration from './RecordDuration.vue'
import ReviewStar from './ReviewStar.vue'
import SourceRepeater from './SourceRepeater.vue'
import SpeakerRecognitionButton from './SpeakerRecognitionButton.vue'

const { records, isAdministrator, activeEditor, playingRecordId, togglePlayback, requestSpeakerRecognition, actionsDisabled, recognitionProps, callsignProps, reviewProps } = useRecordRows('card')
</script>

<template>
  <div class="space-y-3" :class="activeEditor?.view === 'card' ? 'block' : activeEditor?.view === 'table' ? 'hidden' : 'lg:hidden'">
    <article v-for="record in records" :key="record.id" class="rounded-xl border p-4 shadow-xl shadow-black/20" :class="record.reviewed ? 'border-emerald-800/60 bg-emerald-950/40' : 'border-slate-800 bg-slate-900/70'">
      <div class="flex items-center justify-between gap-3">
        <div class="min-w-0">
          <p class="text-sm font-medium text-slate-200">
            {{ formatTime(record.capturedAt) }}<RecordDuration :duration-ms="record.durationMs" :quality="record.audioQuality" class="ml-3 text-xs font-normal" />
          </p>
        </div><div class="flex shrink-0 items-center gap-1">
          <button v-if="record.hasAudio" class="shrink-0 rounded-md border border-slate-700 px-3 py-1.5 text-xs transition hover:bg-slate-700" @click="togglePlayback(record.id)">
            {{ playingRecordId === record.id ? '停止' : '播放' }}
          </button><span v-else class="shrink-0 text-xs text-slate-600">已过期</span>
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
