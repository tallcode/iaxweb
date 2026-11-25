// @vitest-environment jsdom
import type { AdminRecord, AdminRecordPage } from '@iaxweb/contracts'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { adminSession } from '../src/admin-session'
import RecordPagination from '../src/components/records/RecordPagination.vue'

enableAutoUnmount(afterEach)

const replace = vi.fn()

vi.mock('vue-router', () => ({
  useRouter: () => ({ replace }),
  RouterLink: 'a',
}))

beforeEach(() => {
  adminSession.value = { role: 'admin', username: 'admin' }
  vi.stubGlobal('scrollTo', vi.fn())
})

afterEach(() => {
  adminSession.value = null
  replace.mockReset()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('record callsign editing', () => {
  it('allows only one field across records to edit and keeps callsign drafts on blur', async () => {
    vi.stubGlobal('Audio', class extends EventTarget {
      load(): void {}
      pause(): void {}
      removeAttribute(): void {}
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({
      items: [record(), { ...record(), id: 'record-2' }],
      page: 1,
      pageSize: 50,
      total: 2,
    })))
    const { default: RecordsPage } = await import('../src/pages/RecordsPage.vue')
    const wrapper = mount(RecordsPage)
    await flushPromises()
    await wrapper.get('button[aria-label="编辑识别文本"]').trigger('click')
    expect(wrapper.findAll('textarea')).toHaveLength(1)
    for (const button of wrapper.findAll('button[aria-label="编辑主叫呼号"]'))
      expect(button.attributes('disabled')).toBeDefined()
    expect(wrapper.get('input[aria-label="筛选已编辑"]').attributes('disabled')).toBeDefined()
    await wrapper.get('textarea').trigger('keydown', { key: 'Escape' })
    const secondCard = wrapper.findAll('article')[1]!
    await secondCard.get('button[aria-label="编辑主叫呼号"]').trigger('click')
    expect(wrapper.findAll('input[aria-label="编辑主叫呼号"]')).toHaveLength(1)
    const input = wrapper.get<HTMLInputElement>('input[aria-label="编辑主叫呼号"]')
    await input.setValue('BG5ATV')
    await input.trigger('blur')
    expect(input.element.value).toBe('BG5ATV')
    expect(wrapper.findAll('input[aria-label="编辑主叫呼号"]')).toHaveLength(1)
    expect(secondCard.get('button[aria-label="编辑识别文本"]').attributes('disabled')).toBeDefined()
    await wrapper.get('button[aria-label="取消编辑主叫呼号"]').trigger('click')
    expect(wrapper.findAll('input[aria-label="编辑主叫呼号"]')).toHaveLength(0)
    expect(wrapper.get('input[aria-label="筛选已编辑"]').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })

  it('keeps the editor locked while saving and after failure until a successful retry', async () => {
    vi.stubGlobal('Audio', class extends EventTarget {
      load(): void {}
      pause(): void {}
      removeAttribute(): void {}
    })
    let resolveSave!: (response: Response) => void
    const pendingSave = new Promise<Response>((resolve) => {
      resolveSave = resolve
    })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ items: [record()], page: 1, pageSize: 50, total: 1 }))
      .mockReturnValueOnce(pendingSave)
      .mockResolvedValueOnce(jsonResponse({ ...record(), manualCallsign: 'BG5ATV', effectiveCallsign: 'BG5ATV' }))
    vi.stubGlobal('fetch', fetchMock)
    const { default: RecordsPage } = await import('../src/pages/RecordsPage.vue')
    const wrapper = mount(RecordsPage)
    await flushPromises()
    await wrapper.get('button[aria-label="编辑主叫呼号"]').trigger('click')
    await wrapper.get('input[aria-label="编辑主叫呼号"]').setValue('BG5ATV')
    await wrapper.get('button[aria-label="保存主叫呼号"]').trigger('click')
    expect(wrapper.get('button[aria-label="取消编辑主叫呼号"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('button[aria-label="编辑识别文本"]').attributes('disabled')).toBeDefined()
    resolveSave(new Response('failed', { status: 500 }))
    await flushPromises()
    expect(wrapper.get<HTMLInputElement>('input[aria-label="编辑主叫呼号"]').element.value).toBe('BG5ATV')
    expect(wrapper.get('button[aria-label="编辑识别文本"]').attributes('disabled')).toBeDefined()
    await wrapper.get('button[aria-label="保存主叫呼号"]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('input[aria-label="编辑主叫呼号"]')).toHaveLength(0)
    expect(wrapper.get('button[aria-label="编辑识别文本"]').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })

  it('shows the page title and current user and logs out through the server', async () => {
    vi.stubGlobal('Audio', class extends EventTarget {
      load(): void {}
      pause(): void {}
      removeAttribute(): void {}
    })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ items: [record()], page: 1, pageSize: 50, total: 1 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const { default: RecordsPage } = await import('../src/pages/RecordsPage.vue')
    const wrapper = mount(RecordsPage)
    await flushPromises()
    expect(wrapper.get('h1').text()).toBe('记录管理')
    expect(wrapper.get('header [aria-label="当前用户"]').text()).toBe('admin')
    expect(wrapper.get('thead').classes()).toContain('sticky')
    expect(wrapper.get('[aria-label="筛选工具栏"]').classes()).toEqual(expect.arrayContaining(['fixed', 'top-16', 'bg-slate-950']))
    expect(wrapper.get('header').classes()).toEqual(expect.arrayContaining(['fixed', 'top-0']))
    await wrapper.get('header button').trigger('click')
    await flushPromises()
    expect(fetchMock.mock.calls[1]).toEqual(['/api/admin/logout', { method: 'POST' }])
    expect(replace).toHaveBeenCalledWith('/')
    expect(wrapper.findAll('tbody tr')).toHaveLength(0)
    wrapper.unmount()
  })

  it('keeps the account and records visible when logout fails and permits retrying', async () => {
    adminSession.value = { username: 'BG5ATV', role: 'editor' }
    vi.stubGlobal('Audio', class extends EventTarget {
      load(): void {}
      pause(): void {}
      removeAttribute(): void {}
    })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ items: [record()], page: 1, pageSize: 50, total: 1 }))
      .mockResolvedValueOnce(new Response('failed', { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const { default: RecordsPage } = await import('../src/pages/RecordsPage.vue')
    const wrapper = mount(RecordsPage)
    await flushPromises()
    await wrapper.get('header button').trigger('click')
    await flushPromises()
    expect(wrapper.get('header [aria-label="当前用户"]').text()).toBe('BG5ATV')
    expect(wrapper.text()).toContain('注销失败，请重试')
    expect(wrapper.get('header button').attributes('disabled')).toBeUndefined()
    expect(wrapper.findAll('tbody tr')).toHaveLength(1)
    expect(replace).not.toHaveBeenCalled()
    await wrapper.get('header button').trigger('click')
    await flushPromises()
    expect(replace).toHaveBeenCalledWith('/')
    wrapper.unmount()
  })

  it('refreshes on the first 60-second tick when the initial load takes time', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('Audio', class extends EventTarget {
      load(): void {}
      pause(): void {}
      removeAttribute(): void {}
    })
    const page = { items: [record()], page: 1, pageSize: 50, total: 1 }
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        setTimeout(() => resolve(jsonResponse(page)), 500)
      }))
      .mockResolvedValueOnce(jsonResponse(page))
    vi.stubGlobal('fetch', fetchMock)
    const { default: RecordsPage } = await import('../src/pages/RecordsPage.vue')
    const wrapper = mount(RecordsPage)

    await vi.advanceTimersByTimeAsync(59_999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('pauses auto refresh while the page is scrolled down and resumes at the top', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('Audio', class extends EventTarget {
      load(): void {}
      pause(): void {}
      removeAttribute(): void {}
    })
    const page = { items: [record()], page: 1, pageSize: 50, total: 1 }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(page))
      .mockResolvedValueOnce(jsonResponse(page))
    vi.stubGlobal('fetch', fetchMock)
    const { default: RecordsPage } = await import('../src/pages/RecordsPage.vue')
    const wrapper = mount(RecordsPage)
    await flushPromises()
    vi.stubGlobal('scrollY', 120)
    window.dispatchEvent(new Event('scroll'))
    await vi.advanceTimersByTimeAsync(60_000)
    await flushPromises()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.stubGlobal('scrollY', 0)
    window.dispatchEvent(new Event('scroll'))
    await vi.advanceTimersByTimeAsync(60_000)
    await flushPromises()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it.each(['editor', 'viewer', undefined])('hides annotation and deletion columns for role %s', async (role) => {
    vi.stubGlobal('Audio', class extends EventTarget {
      load(): void {}
      pause(): void {}
      removeAttribute(): void {}
    })
    adminSession.value = role ? { username: 'user', role: role === 'editor' ? 'editor' : 'viewer' } : null
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({
      items: [record()],
      page: 1,
      pageSize: 50,
      total: 1,
    })))
    const { default: RecordsPage } = await import('../src/pages/RecordsPage.vue')
    const wrapper = mount(RecordsPage)
    await flushPromises()
    expect(wrapper.get('thead').text()).not.toContain('操作')
    expect(wrapper.get('thead').text()).not.toContain('删除')
    expect(wrapper.findAll('button[aria-label="标注记录"]')).toHaveLength(0)
    expect(wrapper.findAll('button[aria-label="删除记录"]')).toHaveLength(0)
    expect(wrapper.find('input[aria-label="筛选已标注"]').exists()).toBe(true)
    if (role === 'editor') {
      expect(wrapper.findAll('button[aria-label="编辑识别文本"]')).toHaveLength(2)
      expect(wrapper.get('button[aria-label="编辑主叫呼号"]').attributes('disabled')).toBeUndefined()
    }
    else {
      expect(wrapper.findAll('button[aria-label="编辑识别文本"]')).toHaveLength(0)
      expect(wrapper.get('button[aria-label="编辑主叫呼号"]').attributes('disabled')).toBeDefined()
    }
    wrapper.unmount()
  })

  it.each(['admin', 'editor'] as const)('restricts reviewed records to administrators for role %s', async (role) => {
    adminSession.value = { username: 'user', role }
    vi.stubGlobal('Audio', class extends EventTarget {
      load(): void {}
      pause(): void {}
      removeAttribute(): void {}
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({
      items: [{ ...record(), reviewed: true }, { ...record(), id: 'unreviewed', reviewed: false }],
      page: 1,
      pageSize: 50,
      total: 2,
    })))
    const { default: RecordsPage } = await import('../src/pages/RecordsPage.vue')
    const wrapper = mount(RecordsPage)
    await flushPromises()
    const rows = wrapper.findAll('tbody tr')
    expect(rows[0]!.find('button[aria-label="编辑识别文本"]').exists()).toBe(role === 'admin')
    expect(rows[0]!.get('button[aria-label="编辑主叫呼号"]').attributes('disabled') !== undefined).toBe(role !== 'admin')
    expect(rows[1]!.get('button[aria-label="编辑主叫呼号"]').attributes('disabled')).toBeUndefined()
    expect(rows[1]!.find('button[aria-label="编辑识别文本"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('confirms deletion before sending a request and only offers it in the desktop table', async () => {
    vi.stubGlobal('Audio', class extends EventTarget {
      load(): void {}
      pause(): void {}
      removeAttribute(): void {}
    })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ items: [record()], page: 1, pageSize: 50, total: 1 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse({ items: [], page: 1, pageSize: 50, total: 0 }))
    vi.stubGlobal('fetch', fetchMock)
    const { default: RecordsPage } = await import('../src/pages/RecordsPage.vue')
    const wrapper = mount(RecordsPage)
    await flushPromises()
    stubDialog(wrapper.get<HTMLDialogElement>('dialog').element)
    expect(wrapper.findAll('article button[aria-label="删除记录"]')).toHaveLength(0)
    const remove = wrapper.get('tbody button[aria-label="删除记录"]')
    expect(remove.classes()).toContain('text-red-400')
    await remove.trigger('click')
    const dialog = wrapper.get<HTMLDialogElement>('dialog')
    expect(dialog.element.open).toBe(true)
    expect(dialog.text()).toContain('数据库记录和对应录音将被永久删除')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(wrapper.findAll('tbody tr')).toHaveLength(1)
    await dialog.get('button[type="button"]').trigger('click')
    expect(dialog.element.open).toBe(false)
    await remove.trigger('click')
    await dialog.get('form').trigger('submit')
    await flushPromises()
    expect(fetchMock.mock.calls[1]).toEqual(['/api/admin/records/record-1', { method: 'DELETE' }])
    expect(wrapper.findAll('tbody tr')).toHaveLength(0)
    expect(wrapper.text()).toContain('共 0 条记录')
    wrapper.unmount()
  })

  it('keeps the record visible when deletion fails', async () => {
    vi.stubGlobal('Audio', class extends EventTarget {
      load(): void {}
      pause(): void {}
      removeAttribute(): void {}
    })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ items: [record()], page: 1, pageSize: 50, total: 1 }))
      .mockResolvedValueOnce(new Response('failed', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)
    const { default: RecordsPage } = await import('../src/pages/RecordsPage.vue')
    const wrapper = mount(RecordsPage)
    await flushPromises()
    stubDialog(wrapper.get<HTMLDialogElement>('dialog').element)
    await wrapper.get('tbody button[aria-label="删除记录"]').trigger('click')
    await wrapper.get('dialog form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('dialog [role="alert"]').text()).toBe('删除失败，请稍后重试')
    expect(wrapper.get<HTMLDialogElement>('dialog').element.open).toBe(true)
    expect(wrapper.findAll('tbody tr')).toHaveLength(1)
    expect(wrapper.get('tbody button[aria-label="删除记录"]').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })

  it('returns to the previous page after deleting the final record on a page', async () => {
    vi.stubGlobal('scrollTo', vi.fn())
    vi.stubGlobal('Audio', class extends EventTarget {
      load(): void {}
      pause(): void {}
      removeAttribute(): void {}
    })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ items: [record()], page: 1, pageSize: 50, total: 51 }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ ...record(), id: 'last-row' }], page: 2, pageSize: 50, total: 51 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse({ items: [], page: 2, pageSize: 50, total: 50 }))
      .mockResolvedValueOnce(jsonResponse({ items: [record()], page: 1, pageSize: 50, total: 50 }))
    vi.stubGlobal('fetch', fetchMock)
    const { default: RecordsPage } = await import('../src/pages/RecordsPage.vue')
    const wrapper = mount(RecordsPage)
    await flushPromises()
    stubDialog(wrapper.get<HTMLDialogElement>('dialog').element)
    await wrapper.findAll('button').find(button => button.text() === '下一页')!.trigger('click')
    await flushPromises()
    await wrapper.get('tbody button[aria-label="删除记录"]').trigger('click')
    await wrapper.get('dialog form').trigger('submit')
    await flushPromises()
    expect(wrapper.get<HTMLInputElement>('input[aria-label="页码"]').element.value).toBe('1')
    expect(wrapper.text()).toContain('共 50 条记录')
    expect(fetchMock.mock.calls[4]?.[0]).toBe('/api/admin/records?page=1&pageSize=50')
    wrapper.unmount()
  })

  it('uses the backend audio availability flag instead of age or the browser clock for playback', async () => {
    vi.stubGlobal('Audio', class extends EventTarget {
      load(): void {}
      pause(): void {}
      removeAttribute(): void {}
    })
    const items = [
      { ...record(), id: 'old-available', capturedAt: '2020-08-12T23:30:00.000Z', hasAudio: true },
      { ...record(), id: 'missing', capturedAt: new Date().toISOString(), hasAudio: false },
      { ...record(), id: 'future-available', capturedAt: '2099-08-13T00:30:00.000Z', hasAudio: true },
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({
      items,
      page: 1,
      pageSize: 50,
      total: 3,
    })))
    const { default: RecordsPage } = await import('../src/pages/RecordsPage.vue')
    const wrapper = mount(RecordsPage)
    await flushPromises()
    const rows = wrapper.findAll('tbody tr')
    expect(rows[0]!.text()).toContain('播放')
    expect(rows[0]!.text()).not.toContain('已过期')
    expect(rows[1]!.text()).toContain('已过期')
    expect(rows[2]!.text()).toContain('播放')
    wrapper.unmount()
  })

  it('keeps the newest page when an older request finishes later', async () => {
    vi.stubGlobal('scrollTo', vi.fn())
    vi.stubGlobal('Audio', class extends EventTarget {
      load(): void {}
      pause(): void {}
      removeAttribute(): void {}
    })
    let resolveOldPage!: (response: Response) => void
    let resolveNewPage!: (response: Response) => void
    const oldPage = new Promise<Response>(resolve => resolveOldPage = resolve)
    const newPage = new Promise<Response>(resolve => resolveNewPage = resolve)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ items: [record()], page: 1, pageSize: 50, total: 150 }))
      .mockReturnValueOnce(oldPage)
      .mockReturnValueOnce(newPage)
    vi.stubGlobal('fetch', fetchMock)
    const { default: RecordsPage } = await import('../src/pages/RecordsPage.vue')
    const wrapper = mount(RecordsPage)
    await flushPromises()
    const next = wrapper.findAll('button').find(button => button.text() === '下一页')!
    await next.trigger('click')
    const oldSignal = fetchMock.mock.calls[1]![1].signal as AbortSignal
    await next.trigger('click')
    expect(oldSignal.aborted).toBe(true)

    resolveNewPage(jsonResponse({ items: [{ ...record(), id: 'new', recognition: 'Page three' }], page: 3, pageSize: 50, total: 150 }))
    await flushPromises()
    resolveOldPage(jsonResponse({ items: [{ ...record(), id: 'old', recognition: 'Page two' }], page: 2, pageSize: 50, total: 150 }))
    await flushPromises()
    expect(wrapper.text()).toContain('Page three')
    expect(wrapper.text()).not.toContain('Page two')
    expect(wrapper.get<HTMLInputElement>('input[aria-label="页码"]').element.value).toBe('3')
    wrapper.unmount()
  })

  it('restores the visible page and filters when a replacement request fails', async () => {
    vi.stubGlobal('Audio', class extends EventTarget {
      load(): void {}
      pause(): void {}
      removeAttribute(): void {}
    })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ items: [{ ...record(), recognition: 'Original page' }], page: 1, pageSize: 50, total: 51 }))
      .mockRejectedValue(new TypeError('Network unavailable'))
    vi.stubGlobal('fetch', fetchMock)
    const { default: RecordsPage } = await import('../src/pages/RecordsPage.vue')
    const wrapper = mount(RecordsPage)
    await flushPromises()

    await wrapper.findAll('button').find(button => button.text() === '下一页')!.trigger('click')
    await flushPromises()
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/admin/records?page=2&pageSize=50')
    expect(wrapper.get<HTMLInputElement>('input[aria-label="页码"]').element.value).toBe('1')

    const edited = wrapper.get<HTMLInputElement>('input[aria-label="筛选已编辑"]')
    await edited.setValue(true)
    await flushPromises()
    expect(fetchMock.mock.calls[2]?.[0]).toContain('editedOnly=true')
    expect(edited.element.checked).toBe(false)

    const callsign = wrapper.get<HTMLInputElement>('input[aria-label="呼号搜索"]')
    await callsign.setValue('BG5AAA')
    await wrapper.get('form[role="search"]').trigger('submit')
    await flushPromises()
    expect(fetchMock.mock.calls[3]?.[0]).toContain('callsign=BG5AAA')
    expect(callsign.element.value).toBe('')
    expect(wrapper.get('tbody').text()).toContain('Original page')
    wrapper.unmount()
  })

  it('shows the effective callsign and switches to a green manual value after Enter', async () => {
    vi.stubGlobal('Audio', class extends EventTarget {
      src = ''

      load(): void {}
      pause(): void {}
      play(): Promise<void> { return Promise.resolve() }
      removeAttribute(): void {}
    })

    const aiRecord = record()
    const reviewedRecord = { ...aiRecord, effectiveCallsign: 'BG5BBB', manualCallsign: 'BG5BBB' }
    const page: AdminRecordPage = { items: [aiRecord], page: 1, pageSize: 50, total: 1 }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(page))
      .mockResolvedValueOnce(jsonResponse(reviewedRecord))
    vi.stubGlobal('fetch', fetchMock)
    const { default: RecordsPage } = await import('../src/pages/RecordsPage.vue')

    const wrapper = mount(RecordsPage)
    await flushPromises()

    expect(wrapper.text()).toContain('共 1 条记录')
    expect(wrapper.getComponent(RecordPagination).classes()).toEqual(expect.arrayContaining(['sticky', 'bottom-0']))
    const callsign = wrapper.findAll('button').find(button => button.text() === 'BG5AAA')
    expect(callsign?.classes()).toContain('text-slate-100')

    await callsign!.trigger('click')
    const editor = wrapper.get<HTMLInputElement>('input[aria-label="编辑主叫呼号"]')
    await editor.setValue('BG5BBB')
    await editor.trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(wrapper.findAll('input[aria-label="编辑主叫呼号"]')).toHaveLength(0)
    expect(wrapper.text()).toContain('共 1 条记录')
    const updatedCallsign = wrapper.findAll('button').find(button => button.text() === 'BG5BBB')
    expect(updatedCallsign?.classes()).toContain('text-emerald-400')
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      body: JSON.stringify({ callsign: 'BG5BBB' }),
      method: 'PATCH',
    })
    wrapper.unmount()
  })

  it('shows the source repeater in place of the callee in the table and cards', async () => {
    vi.stubGlobal('Audio', class extends EventTarget {
      src = ''

      load(): void {}
      pause(): void {}
      play(): Promise<void> { return Promise.resolve() }
      removeAttribute(): void {}
    })
    const items: AdminRecord[] = [
      { ...record(), calleeCallsign: 'BG5BBB', sourceRepeaterId: '1901', sourceRepeaterName: 'BR5AI' },
      { ...record(), id: 'unconfigured-source', sourceRepeaterId: '1902' },
      { ...record(), id: 'unknown-source' },
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({ items, page: 1, pageSize: 50, total: items.length })))
    const { default: RecordsPage } = await import('../src/pages/RecordsPage.vue')

    const wrapper = mount(RecordsPage)
    await flushPromises()
    expect(wrapper.findAll('thead th').map(header => header.text()).slice(3, 5)).toEqual(['来源中继', '主叫'])
    expect(wrapper.findAll('tbody tr').map(row => row.findAll('td')[3]?.text())).toEqual(['BR5AI', '1902', '-'])
    expect(wrapper.findAll('article').map((card) => {
      const label = card.findAll('span').find(span => span.text() === '来源中继')
      return label?.element.nextElementSibling?.textContent
    })).toEqual(['BR5AI', '1902', '-'])
    expect(wrapper.find('button[aria-label="编辑被叫呼号"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('BG5BBB')
    wrapper.unmount()
  })

  it('returns to the top after changing pages', async () => {
    vi.stubGlobal('Audio', class extends EventTarget {
      src = ''

      load(): void {}
      pause(): void {}
      play(): Promise<void> { return Promise.resolve() }
      removeAttribute(): void {}
    })
    const scrollTo = vi.fn()
    vi.stubGlobal('scrollTo', scrollTo)

    const firstPage: AdminRecordPage = { items: [record()], page: 1, pageSize: 50, total: 51 }
    const secondPage: AdminRecordPage = { items: [{ ...record(), id: 'record-2' }], page: 2, pageSize: 50, total: 51 }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(firstPage))
      .mockResolvedValueOnce(jsonResponse(secondPage))
    vi.stubGlobal('fetch', fetchMock)
    const { default: RecordsPage } = await import('../src/pages/RecordsPage.vue')

    const wrapper = mount(RecordsPage)
    await flushPromises()
    const nextPage = wrapper.findAll('button').find(button => button.text() === '下一页')
    await nextPage!.trigger('click')
    await flushPromises()

    expect(scrollTo).toHaveBeenCalledWith({ behavior: 'smooth', top: 0 })
    wrapper.unmount()
  })

  it('refreshes once per minute only while the page is eligible', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('Audio', class extends EventTarget {
      src = ''

      load(): void {}
      pause(): void {}
      play(): Promise<void> { return Promise.resolve() }
      removeAttribute(): void {}
    })

    const page: AdminRecordPage = { items: [record()], page: 1, pageSize: 50, total: 1 }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(page))
      .mockResolvedValueOnce(jsonResponse(page))
    vi.stubGlobal('fetch', fetchMock)
    const { default: RecordsPage } = await import('../src/pages/RecordsPage.vue')

    const wrapper = mount(RecordsPage)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(60_000)
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('does not refresh while a callsign search is being entered', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('Audio', class extends EventTarget {
      src = ''

      load(): void {}
      pause(): void {}
      play(): Promise<void> { return Promise.resolve() }
      removeAttribute(): void {}
    })

    const page: AdminRecordPage = { items: [record()], page: 1, pageSize: 50, total: 1 }
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(page))
    vi.stubGlobal('fetch', fetchMock)
    const { default: RecordsPage } = await import('../src/pages/RecordsPage.vue')

    const wrapper = mount(RecordsPage)
    await flushPromises()
    await wrapper.get('input[aria-label="呼号搜索"]').setValue('BG5AAA')
    await vi.advanceTimersByTimeAsync(60_000)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it.each([
    ['BG5AAA', 'BG5AAA'],
    ['%aa', '%25AA'],
  ])('applies edit and review filters immediately and combines them with callsign search %s', async (callsign, encodedCallsign) => {
    vi.stubGlobal('Audio', class extends EventTarget {
      src = ''

      load(): void {}
      pause(): void {}
      play(): Promise<void> { return Promise.resolve() }
      removeAttribute(): void {}
    })
    const page: AdminRecordPage = { items: [record()], page: 1, pageSize: 50, total: 1 }
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(page)))
    vi.stubGlobal('fetch', fetchMock)
    const { default: RecordsPage } = await import('../src/pages/RecordsPage.vue')

    const wrapper = mount(RecordsPage)
    await flushPromises()
    expect(wrapper.get('form[role="search"]').text()).toContain('已编辑')
    expect(wrapper.get('form[role="search"]').text()).not.toContain('AI识别')
    await wrapper.get('input[aria-label="筛选已编辑"]').setValue(true)
    await flushPromises()
    expect(fetchMock.mock.calls[1]?.[0]).toContain('editedOnly=true')
    expect(fetchMock.mock.calls[1]?.[0]).not.toContain('callsign=')
    await wrapper.get('input[aria-label="筛选已标注"]').setValue(true)
    await flushPromises()
    expect(fetchMock.mock.calls[2]?.[0]).toContain('editedOnly=true')
    expect(fetchMock.mock.calls[2]?.[0]).toContain('reviewedOnly=true')
    await wrapper.get('input[aria-label="呼号搜索"]').setValue(callsign)
    await wrapper.get('form[role="search"]').trigger('submit')
    await flushPromises()

    expect(fetchMock.mock.calls[3]?.[0]).toContain(`callsign=${encodedCallsign}`)
    expect(fetchMock.mock.calls[3]?.[0]).toContain('editedOnly=true')
    expect(fetchMock.mock.calls[3]?.[0]).toContain('reviewedOnly=true')
    await wrapper.get('input[aria-label="筛选已编辑"]').setValue(false)
    await flushPromises()
    expect(fetchMock.mock.calls[4]?.[0]).toContain(`callsign=${encodedCallsign}`)
    expect(fetchMock.mock.calls[4]?.[0]).not.toContain('editedOnly=')
    expect(fetchMock.mock.calls[4]?.[0]).toContain('reviewedOnly=true')
    await wrapper.findAll('button').find(button => button.text() === '清除')!.trigger('click')
    await flushPromises()
    expect(fetchMock.mock.calls[5]?.[0]).toBe('/api/admin/records?page=1&pageSize=50')
    wrapper.unmount()
  })

  it('refreshes immediately after the page becomes visible when a refresh is overdue', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('Audio', class extends EventTarget {
      src = ''

      load(): void {}
      pause(): void {}
      play(): Promise<void> { return Promise.resolve() }
      removeAttribute(): void {}
    })
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })

    const page: AdminRecordPage = { items: [record()], page: 1, pageSize: 50, total: 1 }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(page))
      .mockResolvedValueOnce(jsonResponse(page))
    vi.stubGlobal('fetch', fetchMock)
    const { default: RecordsPage } = await import('../src/pages/RecordsPage.vue')

    const wrapper = mount(RecordsPage)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    wrapper.unmount()
    delete (document as { visibilityState?: string }).visibilityState
  })
})

function record(): AdminRecord {
  return {
    hasAudio: false,
    calleeCallsign: null,
    callsign: 'BG5AAA',
    callsignAlgorithm: null,
    capturedAt: new Date().toISOString(),
    corrected: null,
    createdAt: new Date().toISOString(),
    durationMs: 1_000,
    effectiveCallsign: 'BG5AAA',
    id: 'record-1',
    manualCallsign: null,
    manualRecognition: null,
    manualNote: null,
    nodeId: '1900',
    recognition: '这里是 BG5AAA',
    reviewed: false,
    voicedMs: 900,
  }
}

function stubDialog(dialog: HTMLDialogElement): void {
  dialog.showModal = vi.fn(() => {
    dialog.open = true
  })
  dialog.close = vi.fn((returnValue = '') => {
    dialog.open = false
    dialog.returnValue = returnValue
    dialog.dispatchEvent(new Event('close'))
  })
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
    status: 200,
  })
}
