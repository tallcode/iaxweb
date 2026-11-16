// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { adminSession } from '../src/admin-session'
import UsersPage from '../src/pages/UsersPage.vue'

const replace = vi.fn()
vi.mock('vue-router', () => ({ useRouter: () => ({ replace }), RouterLink: 'a' }))
beforeEach(() => {
  adminSession.value = { username: 'admin', role: 'admin', system: true }
})
afterEach(() => {
  adminSession.value = null
  replace.mockReset()
  vi.unstubAllGlobals()
})

const guest = { username: 'guest', role: 'viewer' }

function stubDialogs(wrapper: ReturnType<typeof mount>): void {
  for (const dialog of wrapper.findAll<HTMLDialogElement>('dialog')) {
    dialog.element.showModal = vi.fn(() => {
      dialog.element.open = true
    })
    dialog.element.close = vi.fn(() => {
      dialog.element.open = false
      dialog.element.dispatchEvent(new Event('close'))
    })
  }
}

it('filters users by name and creates a new user from the dialog', async () => {
  const editor = { username: 'BG5ATV', role: 'editor' }
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(Response.json({ items: [guest] }))
    .mockResolvedValueOnce(Response.json(editor, { status: 201 }))
    .mockResolvedValueOnce(Response.json({ items: [guest, editor] }))
  vi.stubGlobal('fetch', fetchMock)
  const wrapper = mount(UsersPage)
  await flushPromises()
  stubDialogs(wrapper)
  expect(wrapper.get('h1').text()).toBe('用户管理')
  expect(wrapper.findAll('tbody tr')).toHaveLength(1)
  await wrapper.get('button[aria-label="新增用户"]').trigger('click')
  const dialog = wrapper.get('dialog[aria-labelledby="user-editor-title"]')
  await dialog.get('input[autocomplete="off"]').setValue('BG5ATV')
  await dialog.get('input[type="password"]').setValue('temporary-password')
  await dialog.get('select').setValue('editor')
  await dialog.get('form').trigger('submit')
  await flushPromises()
  expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/admin/users')
  expect(JSON.parse(fetchMock.mock.calls[1]?.[1].body)).toEqual({ username: 'BG5ATV', password: 'temporary-password', role: 'editor' })
  expect(wrapper.findAll('tbody tr')).toHaveLength(2)
  await wrapper.get('input[aria-label="搜索用户名"]').setValue('bg5')
  expect(wrapper.findAll('tbody tr')).toHaveLength(1)
  expect(wrapper.get('tbody').text()).toContain('BG5ATV')
  await wrapper.get('input[aria-label="搜索用户名"]').setValue('missing')
  expect(wrapper.get('tbody').text()).toContain('没有匹配的用户')
  wrapper.unmount()
})

it('omits an unchanged password and shows a save error without closing the editor', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(Response.json({ items: [guest] }))
    .mockResolvedValueOnce(Response.json({ message: '用户名已存在' }, { status: 409 }))
  vi.stubGlobal('fetch', fetchMock)
  const wrapper = mount(UsersPage)
  await flushPromises()
  stubDialogs(wrapper)
  await wrapper.get('button[aria-label="编辑用户"]').trigger('click')
  const dialog = wrapper.get<HTMLDialogElement>('dialog[aria-labelledby="user-editor-title"]')
  await dialog.get('form').trigger('submit')
  await flushPromises()
  expect(JSON.parse(fetchMock.mock.calls[1]?.[1].body)).toEqual({ username: 'guest', role: 'viewer' })
  expect(dialog.get('[role="alert"]').text()).toBe('用户名已存在')
  expect(dialog.element.open).toBe(true)
  wrapper.unmount()
})

it('requires confirmation before deleting a user and reloads the list afterwards', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(Response.json({ items: [guest] }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(Response.json({ items: [] }))
  vi.stubGlobal('fetch', fetchMock)
  const wrapper = mount(UsersPage)
  await flushPromises()
  stubDialogs(wrapper)
  await wrapper.get('button[aria-label="删除用户"]').trigger('click')
  const dialog = wrapper.get<HTMLDialogElement>('dialog[aria-labelledby="user-delete-title"]')
  expect(dialog.text()).toContain('guest')
  expect(fetchMock).toHaveBeenCalledTimes(1)
  await dialog.get('button[type="button"]').trigger('click')
  expect(dialog.element.open).toBe(false)
  await wrapper.get('button[aria-label="删除用户"]').trigger('click')
  await dialog.get('form').trigger('submit')
  await flushPromises()
  expect(fetchMock.mock.calls[1]).toEqual(['/api/admin/users/guest', { method: 'DELETE' }])
  expect(wrapper.get('tbody').text()).toContain('暂无用户')
  wrapper.unmount()
})

it('redirects users without administrator permission to records', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Forbidden', { status: 403 })))
  const wrapper = mount(UsersPage)
  await flushPromises()
  expect(replace).toHaveBeenCalledWith('/records')
  wrapper.unmount()
})
