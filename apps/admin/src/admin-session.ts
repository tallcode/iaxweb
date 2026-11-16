import type { AdminSession } from '@iaxweb/contracts'
import { shallowRef } from 'vue'

export const adminSession = shallowRef<AdminSession | null>(null)

export async function refreshAdminSession(): Promise<AdminSession | null> {
  try {
    const response = await fetch('/api/admin/session')
    adminSession.value = response.ok ? await response.json() as AdminSession : null
    return adminSession.value
  }
  catch (error) {
    adminSession.value = null
    throw error
  }
}
