import { afterEach, expect, it, vi } from 'vitest'
import { ApiError } from '../src/api/client'
import { recordsApi } from '../src/api/records'
import { sessionApi } from '../src/api/session'
import { usersApi } from '../src/api/users'

afterEach(() => vi.unstubAllGlobals())

it('distinguishes invalid server data from network and authentication failures', async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ items: 'invalid' })).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
  vi.stubGlobal('fetch', fetchMock)
  const query = { page: 1, pageSize: 50 }
  await expect(recordsApi.list(query)).rejects.toMatchObject({ kind: 'protocol', status: 200 })
  await expect(recordsApi.list(query)).rejects.toMatchObject({ kind: 'network' })
  await expect(recordsApi.list(query)).rejects.toMatchObject({ kind: 'http', status: 401 })
})

it('validates typed record mutations before issuing a request', async () => {
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  expect(() => recordsApi.updateRecognition('record', '中'.repeat(1001))).toThrow(ApiError)
  expect(() => recordsApi.updateCallsign('record', 'INVALID')).toThrow(ApiError)
  expect(fetchMock).not.toHaveBeenCalled()
})

it('treats an expired session as signed out and propagates other server failures', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 }))
    .mockResolvedValueOnce(new Response(null, { status: 500 })))
  await expect(sessionApi.current()).resolves.toBeNull()
  await expect(sessionApi.current()).rejects.toMatchObject({ kind: 'http', status: 500 })
})

it('preserves omitted fields in partial user updates instead of applying creation defaults', async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ username: 'editor', role: 'editor' }))
  vi.stubGlobal('fetch', fetchMock)
  await usersApi.update('editor', { password: 'new-password' })
  expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body)).toEqual({ password: 'new-password' })
})
