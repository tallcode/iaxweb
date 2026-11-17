<script setup lang="ts">
import { CALLSIGN_HINT, MANUAL_CALLSIGN_PATTERN as CALLSIGN_PATTERN } from '@iaxweb/contracts'
import { computed, ref } from 'vue'
import { useRecordsFeedbackContext, useRecordsQueryContext } from '../../composables/records/use-records-context'
import { useToolbarHeight } from '../../composables/use-toolbar-height'

const { state, actions } = useRecordsQueryContext()
const { total, callsignFilter, isLoading, disabled } = state
const { searchCallsign, applyFilters, clearCallsignSearch } = actions
const { message: statusMessage, kind } = useRecordsFeedbackContext()
const searchInput = computed({ get: () => state.searchInput.value, set: actions.setSearchInput })
const editedOnly = computed({ get: () => state.editedOnly.value, set: actions.setEditedOnly })
const reviewedOnly = computed({ get: () => state.reviewedOnly.value, set: actions.setReviewedOnly })
const isRecordSummary = computed(() => kind.value === 'summary')
const compactStatus = computed(() => isRecordSummary.value
  ? `${total.value < 10_000 ? total.value : `${Number((total.value / 10_000).toFixed(1))}万`}条`
  : '提示')
const toolbar = ref<HTMLElement>()
const searchField = ref<HTMLInputElement>()
useToolbarHeight(toolbar)
function normalizeSearchInput(event: Event): void {
  const field = event.currentTarget as HTMLInputElement
  field.value = field.value.toUpperCase().replaceAll(/\s+/g, '')
  searchInput.value = field.value
  field.setCustomValidity(field.value.length === 0 || CALLSIGN_PATTERN.test(field.value) ? '' : CALLSIGN_HINT)
}
defineExpose({ focusSearch: () => searchField.value?.focus() })
</script>

<template>
  <div ref="toolbar" class="fixed inset-x-0 top-16 z-20 min-h-16 bg-slate-950" aria-label="筛选工具栏">
    <div class="mx-auto flex min-h-16 max-w-screen-2xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8">
      <p class="shrink-0 whitespace-nowrap text-sm text-slate-400" :title="statusMessage" :aria-label="statusMessage">
        <span class="sm:hidden">{{ compactStatus }}</span>
        <span class="hidden sm:inline">{{ statusMessage }}</span>
      </p>
      <form class="ml-auto flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2 sm:flex-none sm:gap-3" role="search" @submit.prevent="searchCallsign">
        <div class="flex items-center gap-3">
          <label class="flex min-h-10 shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap text-sm text-slate-300"><input v-model="editedOnly" type="checkbox" :disabled="disabled" class="size-3.5 shrink-0 accent-cyan-500" aria-label="筛选已编辑" @change="applyFilters">已编辑</label>
          <label class="flex min-h-10 shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap text-sm text-slate-300"><input v-model="reviewedOnly" type="checkbox" :disabled="disabled" class="size-3.5 shrink-0 accent-cyan-500" aria-label="筛选已标注" @change="applyFilters">已标注</label>
        </div>
        <div class="flex items-center gap-2">
          <input ref="searchField" v-model="searchInput" :disabled="disabled" lang="en" autocapitalize="characters" autocomplete="off" autocorrect="off" class="w-[calc(8ch+1.5rem+2px)] flex-none rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm uppercase outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/20 sm:w-[calc(16ch+1.5rem+2px)]" inputmode="text" :pattern="CALLSIGN_PATTERN.source" placeholder="呼号" aria-label="呼号搜索" spellcheck="false" @input="normalizeSearchInput">
          <button v-if="searchInput || callsignFilter || editedOnly || reviewedOnly" type="button" aria-label="清除" :disabled="disabled" title="清除搜索和筛选" class="hidden shrink-0 items-center justify-center rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 transition hover:border-slate-500 hover:bg-slate-800 focus:outline-none sm:inline-flex" @click="clearCallsignSearch">
            清除
          </button>
          <button type="submit" aria-label="搜索" :disabled="disabled" title="搜索" class="inline-flex size-10 shrink-0 items-center justify-center rounded-lg border border-slate-700 text-sm text-slate-300 transition hover:border-slate-500 hover:bg-slate-800 focus:outline-none sm:h-auto sm:w-auto sm:px-4 sm:py-2">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="size-4 sm:hidden" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>
            <span class="hidden sm:inline">搜索</span>
          </button>
        </div>
      </form>
      <p v-if="statusMessage && !isRecordSummary && !isLoading" role="status" class="basis-full break-words text-xs text-amber-300">
        {{ statusMessage }}
      </p>
    </div>
  </div>
</template>
