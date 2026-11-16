import type { AdminRole, AdminUsersPage } from '@iaxweb/contracts'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AdminAuth, UserUpdate } from '../admin/auth.js'
import { UserManagementError } from '../admin/auth.js'

interface UserBody {
  username?: unknown
  password?: unknown
  role?: unknown
}

interface UserParams {
  username: string
}

type RequireAdministrator = (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | undefined>

export function registerUserRoutes(app: FastifyInstance, auth: AdminAuth, requireAdministrator: RequireAdministrator): void {
  app.get('/users', { preHandler: requireAdministrator }, async (_request, reply) => {
    const page: AdminUsersPage = { items: auth.listUsers() }
    return reply.header('cache-control', 'no-store').send(page)
  })

  app.get<{ Params: UserParams }>('/users/:username', { preHandler: requireAdministrator }, async (request, reply) => {
    const user = auth.findUser(request.params.username)
    return user
      ? reply.header('cache-control', 'no-store').send(user)
      : reply.code(404).send({ message: '用户不存在' })
  })

  app.post<{ Body: UserBody }>('/users', { preHandler: requireAdministrator }, async (request, reply) => {
    const { username, password, role = 'viewer' } = request.body ?? {}
    if (typeof username !== 'string' || typeof password !== 'string' || !isRole(role))
      return reply.code(400).send({ message: '请填写用户名、密码并选择有效角色' })
    try {
      const user = await auth.createUser(username, password, role)
      return reply.header('cache-control', 'no-store').code(201).send(user)
    }
    catch (error) {
      return userError(error, request, reply)
    }
  })

  app.patch<{ Body: UserBody, Params: UserParams }>('/users/:username', { preHandler: requireAdministrator }, async (request, reply) => {
    const body = request.body ?? {}
    const patch: UserUpdate = {}
    if (body.username !== undefined) {
      if (typeof body.username !== 'string')
        return reply.code(400).send({ message: '用户名格式无效' })
      patch.username = body.username
    }
    if (body.password !== undefined) {
      if (typeof body.password !== 'string')
        return reply.code(400).send({ message: '密码格式无效' })
      patch.password = body.password
    }
    if (body.role !== undefined) {
      if (!isRole(body.role))
        return reply.code(400).send({ message: '角色无效' })
      patch.role = body.role
    }
    if (Object.keys(patch).length === 0)
      return reply.code(400).send({ message: '请提供需要修改的用户信息' })
    try {
      const user = await auth.updateUser(request.params.username, patch)
      return reply.header('cache-control', 'no-store').send(user)
    }
    catch (error) {
      return userError(error, request, reply)
    }
  })

  app.delete<{ Params: UserParams }>('/users/:username', { preHandler: requireAdministrator }, async (request, reply) => {
    try {
      auth.deleteUser(request.params.username)
      return reply.header('cache-control', 'no-store').code(204).send()
    }
    catch (error) {
      return userError(error, request, reply)
    }
  })
}

function isRole(value: unknown): value is AdminRole {
  return value === 'admin' || value === 'editor' || value === 'viewer'
}

function userError(error: unknown, request: FastifyRequest, reply: FastifyReply): FastifyReply {
  if (error instanceof UserManagementError)
    return reply.code(error.statusCode).send({ message: error.message })
  request.log.error({ err: error }, 'Failed to persist user changes')
  return reply.code(500).send({ message: '保存用户失败，请稍后重试' })
}
