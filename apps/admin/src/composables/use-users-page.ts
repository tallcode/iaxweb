import type { AdminRole, AdminSession } from '@iaxweb/contracts'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { adminSession as currentUser } from '../admin-session'
import { ApiError, apiErrorMessage } from '../api/client'
import { sessionApi } from '../api/session'
import { usersApi } from '../api/users'

export interface UserDraft {
  username: string
  password: string
  role: AdminRole
}

export function useUsersPage() {
  const router = useRouter()
  const users = ref<AdminSession[]>([])
  const search = ref('')
  const status = ref('')
  const loading = ref(false)
  const saving = ref(false)
  const loggingOut = ref(false)
  const editorError = ref('')
  const deleteError = ref('')
  let request: AbortController | undefined

  const filteredUsers = computed(() => {
    const keyword = search.value.trim().toLocaleLowerCase()
    return users.value.filter(user => !keyword || user.username.toLocaleLowerCase().includes(keyword))
  })

  onMounted(() => void loadUsers())
  onBeforeUnmount(() => request?.abort())

  async function handleAccessError(error: unknown): Promise<boolean> {
    if (!(error instanceof ApiError))
      return false
    if (error.status === 401) {
      await router.replace('/')
      return true
    }
    if (error.status === 403) {
      await router.replace('/records')
      return true
    }
    return false
  }

  async function loadUsers(): Promise<void> {
    request?.abort()
    const activeRequest = new AbortController()
    request = activeRequest
    loading.value = true
    status.value = ''
    try {
      const page = await usersApi.list(activeRequest.signal)
      if (!activeRequest.signal.aborted)
        users.value = page.items
    }
    catch (error) {
      if (!activeRequest.signal.aborted && !await handleAccessError(error))
        status.value = apiErrorMessage(error, '加载用户失败，请重试')
    }
    finally {
      if (request === activeRequest) {
        loading.value = false
        request = undefined
      }
    }
  }

  async function logout(): Promise<void> {
    if (loggingOut.value || saving.value)
      return
    loggingOut.value = true
    request?.abort()
    try {
      await sessionApi.logout()
      users.value = []
      currentUser.value = null
      await router.replace('/')
    }
    catch (error) {
      status.value = apiErrorMessage(error, '注销失败，请重试')
    }
    finally {
      loggingOut.value = false
    }
  }

  async function saveUser(originalName: string | null, draft: UserDraft, close: () => void): Promise<void> {
    if (saving.value)
      return
    saving.value = true
    editorError.value = ''
    const isCurrentUser = originalName !== null && originalName === currentUser.value?.username
    const body = { username: draft.username.trim(), role: draft.role, ...(draft.password ? { password: draft.password } : {}) }
    try {
      if (originalName === null)
        await usersApi.create({ ...body, password: draft.password })
      else
        await usersApi.update(originalName, body)
      if (isCurrentUser && (body.username !== originalName || body.password)) {
        close()
        await router.replace('/')
        return
      }
      if (isCurrentUser && body.role !== 'admin') {
        close()
        await router.replace('/records')
        return
      }
      await loadUsers()
      close()
    }
    catch (error) {
      if (!await handleAccessError(error))
        editorError.value = apiErrorMessage(error, '保存用户失败，请重试')
    }
    finally {
      saving.value = false
    }
  }

  async function deleteUser(username: string, close: () => void): Promise<void> {
    if (saving.value)
      return
    saving.value = true
    deleteError.value = ''
    try {
      await usersApi.delete(username)
      if (username === currentUser.value?.username) {
        close()
        await router.replace('/')
        return
      }
      await loadUsers()
      close()
    }
    catch (error) {
      if (!await handleAccessError(error))
        deleteError.value = apiErrorMessage(error, '删除用户失败，请重试')
    }
    finally {
      saving.value = false
    }
  }

  return { currentUser, filteredUsers, search, status, loading, saving, loggingOut, editorError, deleteError, logout, saveUser, deleteUser }
}
