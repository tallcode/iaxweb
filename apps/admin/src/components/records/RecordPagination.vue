<script setup lang="ts">
import { computed } from 'vue'
import { useRecordsQueryContext } from '../../composables/records/use-records-context'

const { state, actions } = useRecordsQueryContext()
const { currentPage, pageCount, disabled } = state
const { changePage, goToPage } = actions
const pageInput = computed({ get: () => state.pageInput.value, set: actions.setPageInput })
</script>

<template>
  <nav class="sticky bottom-0 z-10 -mx-4 mt-3 flex shrink-0 flex-wrap items-center justify-center gap-2 border-t border-slate-800 bg-slate-950 px-3 py-2 text-xs sm:-mx-6 sm:gap-3 sm:px-6 sm:py-3 sm:text-sm lg:-mx-8 lg:px-8">
    <button :disabled="disabled || currentPage <= 1" class="whitespace-nowrap rounded-lg border border-slate-700 px-2.5 py-1.5 disabled:cursor-not-allowed disabled:opacity-40 sm:px-4 sm:py-2" @click="changePage(currentPage - 1)">
      上一页
    </button><form class="flex items-center gap-1 text-slate-400 sm:gap-2" aria-label="页码跳转" @submit.prevent="goToPage">
      <span>第</span><input v-model="pageInput" type="number" :disabled="disabled" min="1" :max="pageCount" class="w-12 rounded-md border border-slate-700 bg-slate-950 px-1 py-1 text-center text-slate-200 outline-none focus:border-cyan-500 sm:w-16 sm:px-2 sm:py-1.5" aria-label="页码"><span>/ {{ pageCount }} 页</span><button type="submit" :disabled="disabled" class="rounded-md border border-slate-700 px-2 py-1 text-slate-300 transition hover:border-slate-500 hover:bg-slate-800 sm:px-3 sm:py-1.5">
        跳转
      </button>
    </form><button :disabled="disabled || currentPage >= pageCount" class="whitespace-nowrap rounded-lg border border-slate-700 px-2.5 py-1.5 disabled:cursor-not-allowed disabled:opacity-40 sm:px-4 sm:py-2" @click="changePage(currentPage + 1)">
      下一页
    </button>
  </nav>
</template>
