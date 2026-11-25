<script setup lang="ts">
import { useRecordRows } from '../../composables/records/use-record-rows'
import { formatRecordTime as formatTime } from '../../utils/records-format'
import RecognitionEditor from './RecognitionEditor.vue'
import RecordCallsign from './RecordCallsign.vue'
import RecordDuration from './RecordDuration.vue'
import ReviewStar from './ReviewStar.vue'
import SourceRepeater from './SourceRepeater.vue'
import SpeakerRecognitionButton from './SpeakerRecognitionButton.vue'

const { records, isAdministrator, activeEditor, playingRecordId, togglePlayback, requestSpeakerRecognition, requestDeletion, actionsDisabled, recognitionProps, callsignProps, reviewProps } = useRecordRows('table')
</script>

<template>
  <div class="overflow-clip rounded-xl border border-slate-800 bg-slate-900/70 shadow-xl shadow-black/20" :class="activeEditor?.view === 'table' ? 'block' : activeEditor?.view === 'card' ? 'hidden' : 'hidden lg:block'">
    <table class="w-full table-fixed divide-y divide-slate-800 text-left text-sm leading-6" :class="isAdministrator ? 'min-w-[55rem]' : 'min-w-[49rem]'">
      <colgroup><col class="w-44"><col class="w-16"><col><col class="w-24"><col class="w-32"><col class="w-24"><col v-if="isAdministrator" class="w-32"></colgroup><thead class="sticky top-[calc(4rem+var(--records-toolbar-height,4rem))] z-10 bg-slate-900 text-xs uppercase tracking-wide text-slate-400">
        <tr>
          <th class="whitespace-nowrap px-4 py-3">
            时间
          </th><th class="whitespace-nowrap px-4 py-3">
            时长
          </th><th class="px-4 py-3">
            识别文本
          </th><th class="whitespace-nowrap px-4 py-3">
            来源
          </th><th class="whitespace-nowrap px-4 py-3">
            主叫
          </th><th class="whitespace-nowrap px-4 py-3">
            播放
          </th><th v-if="isAdministrator" class="whitespace-nowrap px-4 py-3">
            操作
          </th>
        </tr>
      </thead><tbody class="divide-y divide-slate-800/80">
        <tr v-for="record in records" :key="record.id" class="align-top transition" :class="record.reviewed ? 'bg-emerald-950/40 hover:bg-emerald-900/30' : 'hover:bg-slate-800/40'">
          <td class="whitespace-nowrap px-4 py-4 text-slate-400">
            {{ formatTime(record.capturedAt) }}
          </td><td class="whitespace-nowrap px-4 py-4">
            <RecordDuration :duration-ms="record.durationMs" :quality="record.audioQuality" />
          </td><td class="px-4 py-4">
            <RecognitionEditor v-bind="recognitionProps(record)" />
          </td><td class="px-4 py-4">
            <SourceRepeater :value="record.sourceRepeaterName ?? record.sourceRepeaterId" />
          </td><td class="px-4 py-3">
            <RecordCallsign v-bind="callsignProps(record, 'caller')" />
          </td><td class="px-4 py-3">
            <button v-if="record.hasAudio" class="inline-flex h-8 items-center rounded-md border border-slate-700 px-3 py-1.5 text-xs transition hover:bg-slate-700" @click="togglePlayback(record.id)">
              {{ playingRecordId === record.id ? '停止' : '播放' }}
            </button><span v-else class="inline-flex h-8 items-center text-xs text-slate-600">已过期</span>
          </td><td v-if="isAdministrator" class="px-3 py-3">
            <div class="flex items-center gap-1">
              <SpeakerRecognitionButton :disabled="actionsDisabled()" @recognize="requestSpeakerRecognition(record)" />
              <ReviewStar v-bind="reviewProps(record)" />
              <button type="button" aria-label="删除记录" title="删除记录和录音" :disabled="actionsDisabled()" class="inline-flex size-8 items-center justify-center rounded-md text-red-400 transition hover:bg-red-500/10 hover:text-red-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50 disabled:cursor-not-allowed disabled:opacity-40" @click="requestDeletion(record)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="size-4" aria-hidden="true"><path d="M3 6h18M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M5 6l1 14a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1l1-14M10 10v7M14 10v7" /></svg>
              </button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
