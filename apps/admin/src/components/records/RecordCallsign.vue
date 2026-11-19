<script setup lang="ts">
import type { PersistedRecord } from '@iaxweb/contracts'
import type { CallsignRole } from '../../composables/records/types'
import { CALLSIGN_HINT, MANUAL_CALLSIGN_PATTERN } from '@iaxweb/contracts'
import CallsignEditor from './CallsignEditor.vue'
import CallsignText from './CallsignText.vue'

defineProps<{
  record: PersistedRecord
  role: CallsignRole
  editing: boolean
  disabled: boolean
  saving: boolean
  save: (value: string | null) => Promise<boolean>
}>()
const emit = defineEmits<{ begin: [], close: [] }>()
</script>

<template>
  <CallsignEditor v-if="editing" :value="role === 'callee' ? record.calleeCallsign : record.effectiveCallsign" :label="role === 'callee' ? '被叫' : '主叫'" :pattern="MANUAL_CALLSIGN_PATTERN" :hint="CALLSIGN_HINT" :disabled="saving" :save="save" @close="emit('close')" />
  <button v-else type="button" class="inline-flex h-8 cursor-text items-center font-mono focus:outline-none disabled:cursor-default" :class="(role === 'callee' ? record.calleeCallsign : record.manualCallsign) !== null ? 'text-emerald-400' : 'text-slate-100'" :disabled="disabled" :aria-label="`编辑${role === 'callee' ? '被叫' : '主叫'}呼号`" @click="emit('begin')">
    <template v-if="role === 'callee'">
      {{ record.calleeCallsign ?? '—' }}
    </template>
    <CallsignText v-else :original="record.callsign" :manual="record.manualCallsign" :algorithm="record.callsignAlgorithm" />
  </button>
</template>
