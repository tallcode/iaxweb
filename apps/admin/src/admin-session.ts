import type { AdminSession } from '@iaxweb/contracts'
import { shallowRef } from 'vue'
import { sessionApi } from './api/session'

export const adminSession = shallowRef<AdminSession | null>(null)

export async function refreshAdminSession(): Promise<AdminSession | null> {
  try {
    adminSession.value = await sessionApi.current()
    return adminSession.value
  }
  catch (error) {
    adminSession.value = null
    throw error
  }
}
