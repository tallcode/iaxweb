import type { CreateUserInput, UpdateUserInput } from '@iaxweb/contracts'
import { adminSessionSchema, adminUsersPageSchema, createUserSchema, updateUserSchema } from '@iaxweb/contracts'
import { parseInput, request, requestJson } from './client'

const userUrl = (username: string): string => `/api/admin/users/${encodeURIComponent(username)}`
export const usersApi = {
  list(signal?: AbortSignal) { return requestJson('/api/admin/users', adminUsersPageSchema, { signal }) },
  create(input: CreateUserInput) {
    return requestJson('/api/admin/users', adminSessionSchema, { method: 'POST', body: parseInput(createUserSchema, input, '请填写有效的用户名、密码和角色') })
  },
  update(username: string, input: UpdateUserInput) {
    return requestJson(userUrl(username), adminSessionSchema, { method: 'PATCH', body: parseInput(updateUserSchema, input, '请提供有效的用户修改信息') })
  },
  async delete(username: string): Promise<void> {
    await request(userUrl(username), { method: 'DELETE', acceptedStatuses: [404] })
  },
}
