<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { ApiError, apiErrorMessage } from '../api/client'
import { sessionApi } from '../api/session'

const router = useRouter()
const username = ref('')
const password = ref('')
const loginError = ref('')
const submitting = ref(false)

async function login(): Promise<void> {
  submitting.value = true
  loginError.value = ''
  try {
    await sessionApi.login({ username: username.value, password: password.value })
    password.value = ''
    await router.replace('/records')
  }
  catch (error) {
    loginError.value = error instanceof ApiError && error.status === 429
      ? '登录尝试过多，请稍后再试'
      : error instanceof ApiError && error.status === 401
        ? '用户名或密码错误'
        : apiErrorMessage(error, '登录失败')
  }
  finally {
    submitting.value = false
  }
}
</script>

<template>
  <main class="min-h-dvh bg-slate-950 px-4 py-10 text-slate-100 sm:px-6 lg:px-8">
    <section class="mx-auto max-w-md rounded-2xl border border-slate-800 bg-slate-900/80 p-7 shadow-2xl shadow-black/30 backdrop-blur">
      <h1 class="mb-6 text-2xl font-semibold tracking-tight">
        管理登录
      </h1>
      <form class="space-y-5" @submit.prevent="login">
        <label class="flex flex-col gap-2 text-sm text-slate-300">
          <span>用户名</span>
          <input v-model="username" autocomplete="username" required class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/20">
        </label>
        <label class="flex flex-col gap-2 text-sm text-slate-300">
          <span>密码</span>
          <input v-model="password" type="password" autocomplete="current-password" required class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/20">
        </label>
        <p v-if="loginError" class="text-sm text-red-400">
          {{ loginError }}
        </p>
        <button :disabled="submitting" class="w-full rounded-lg bg-cyan-600 px-4 py-2.5 font-medium text-white transition hover:bg-cyan-500 disabled:cursor-wait disabled:opacity-70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400">
          登录
        </button>
      </form>
    </section>
  </main>
</template>
