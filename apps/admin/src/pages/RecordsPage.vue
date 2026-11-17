<script setup lang="ts">
import { ref } from 'vue'
import { RouterLink } from 'vue-router'
import AdminPageHeader from '../components/AdminPageHeader.vue'
import DeleteRecordDialog from '../components/records/DeleteRecordDialog.vue'
import RecordCardList from '../components/records/RecordCardList.vue'
import RecordFilters from '../components/records/RecordFilters.vue'
import RecordPagination from '../components/records/RecordPagination.vue'
import RecordTable from '../components/records/RecordTable.vue'
import SpeakerRecognitionDialog from '../components/records/SpeakerRecognitionDialog.vue'
import { provideRecords } from '../composables/records/use-records-context'
import { useRecordsPage } from '../composables/records/use-records-page'

const context = useRecordsPage({ onNavigate: () => window.scrollTo({ behavior: 'smooth', top: 0 }) })
provideRecords(context)
const { username, loggingOut, controlsDisabled, isAdministrator, logout } = context
const filters = ref<InstanceType<typeof RecordFilters>>()
</script>

<template>
  <div class="min-h-dvh bg-slate-950 text-slate-100">
    <AdminPageHeader title="记录管理" :username="username" :logging-out="loggingOut" :disabled="controlsDisabled" @logout="logout">
      <RouterLink v-if="isAdministrator" to="/users" class="shrink-0 text-xs text-slate-400 transition hover:text-slate-100 sm:text-sm">
        用户管理
      </RouterLink>
    </AdminPageHeader>
    <main :inert="loggingOut" class="records-main mx-auto flex min-h-dvh w-full max-w-screen-2xl flex-col px-4 sm:px-6 lg:px-8">
      <RecordFilters ref="filters" />
      <div role="region" aria-label="识别记录" class="flex-1">
        <RecordCardList />
        <RecordTable />
      </div>
      <RecordPagination />
    </main>
    <DeleteRecordDialog @focus-search="filters?.focusSearch()" />
    <SpeakerRecognitionDialog />
  </div>
</template>
