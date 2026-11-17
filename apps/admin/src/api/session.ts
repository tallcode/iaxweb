import type { LoginInput } from '@iaxweb/contracts'
import { adminSessionSchema, loginSchema } from '@iaxweb/contracts'
import { parseInput, parseResponse, request } from './client'

export const sessionApi = {
  async current() {
    const response = await request('/api/admin/session', { acceptedStatuses: [401] })
    return response.status === 401 ? null : parseResponse(response, adminSessionSchema)
  },
  async login(input: LoginInput): Promise<void> {
    await request('/api/admin/login', { method: 'POST', body: parseInput(loginSchema, input, '请输入用户名和密码') })
  },
  async logout(): Promise<void> {
    await request('/api/admin/logout', { method: 'POST', acceptedStatuses: [401] })
  },
}
