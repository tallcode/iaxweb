// @vitest-environment jsdom
import type { PersistedSegment, SegmentPage } from '@iaxweb/contracts'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

const replace = vi.fn()

vi.mock('vue-router', () => ({
  useRouter: () => ({ replace }),
}))

afterEach(() => {
  replace.mockReset()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('record callsign editing', () => {
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
      .mockResolvedValueOnce(jsonResponse({ items: [segment()], page: 1, pageSize: 50, total: 150 }))
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

    resolveNewPage(jsonResponse({ items: [{ ...segment(), id: 'new', recognition: 'Page three' }], page: 3, pageSize: 50, total: 150 }))
    await flushPromises()
    resolveOldPage(jsonResponse({ items: [{ ...segment(), id: 'old', recognition: 'Page two' }], page: 2, pageSize: 50, total: 150 }))
    await flushPromises()
    expect(wrapper.text()).toContain('Page three')
    expect(wrapper.text()).not.toContain('Page two')
    expect(wrapper.get<HTMLInputElement>('input[aria-label="页码"]').element.value).toBe('3')
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

    const aiSegment = segment()
    const reviewedSegment = { ...aiSegment, effectiveCallsign: 'BG5BBB', manualCallsign: 'BG5BBB' }
    const page: SegmentPage = { items: [aiSegment], page: 1, pageSize: 50, total: 1 }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(page))
      .mockResolvedValueOnce(jsonResponse(reviewedSegment))
    vi.stubGlobal('fetch', fetchMock)
    const { default: RecordsPage } = await import('../src/pages/RecordsPage.vue')

    const wrapper = mount(RecordsPage)
    await flushPromises()

    expect(wrapper.text()).toContain('共 1 条记录')
    expect(wrapper.get('nav').classes()).toEqual(expect.arrayContaining(['sticky', 'bottom-0']))
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

  it('saves a manually reviewed callee callsign', async () => {
    vi.stubGlobal('Audio', class extends EventTarget {
      src = ''

      load(): void {}
      pause(): void {}
      play(): Promise<void> { return Promise.resolve() }
      removeAttribute(): void {}
    })
    const aiSegment = segment()
    const reviewedSegment = { ...aiSegment, calleeCallsign: 'BG5BBB' }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ items: [aiSegment], page: 1, pageSize: 50, total: 1 }))
      .mockResolvedValueOnce(jsonResponse(reviewedSegment))
    vi.stubGlobal('fetch', fetchMock)
    const { default: RecordsPage } = await import('../src/pages/RecordsPage.vue')

    const wrapper = mount(RecordsPage)
    await flushPromises()
    const callee = wrapper.findAll('button').find(button => button.text() === '—')
    await callee!.trigger('click')
    const editor = wrapper.get<HTMLInputElement>('input[aria-label="编辑被叫呼号"]')
    await editor.setValue('BG5BBB')
    await editor.trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(wrapper.text()).toContain('BG5BBB')
    expect(fetchMock.mock.calls[1]?.[0]).toContain('/manual-callee-callsign')
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ body: JSON.stringify({ callsign: 'BG5BBB' }), method: 'PATCH' })
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

    const firstPage: SegmentPage = { items: [segment()], page: 1, pageSize: 50, total: 51 }
    const secondPage: SegmentPage = { items: [{ ...segment(), id: 'segment-2' }], page: 2, pageSize: 50, total: 51 }
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

    const page: SegmentPage = { items: [segment()], page: 1, pageSize: 50, total: 1 }
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

    const page: SegmentPage = { items: [segment()], page: 1, pageSize: 50, total: 1 }
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

  it('applies edit and review filters immediately without a callsign and combines them with search', async () => {
    vi.stubGlobal('Audio', class extends EventTarget {
      src = ''

      load(): void {}
      pause(): void {}
      play(): Promise<void> { return Promise.resolve() }
      removeAttribute(): void {}
    })
    const page: SegmentPage = { items: [segment()], page: 1, pageSize: 50, total: 1 }
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
    await wrapper.get('input[aria-label="呼号搜索"]').setValue('BG5AAA')
    await wrapper.get('form[role="search"]').trigger('submit')
    await flushPromises()

    expect(fetchMock.mock.calls[3]?.[0]).toContain('callsign=BG5AAA')
    expect(fetchMock.mock.calls[3]?.[0]).toContain('editedOnly=true')
    expect(fetchMock.mock.calls[3]?.[0]).toContain('reviewedOnly=true')
    await wrapper.get('input[aria-label="筛选已编辑"]').setValue(false)
    await flushPromises()
    expect(fetchMock.mock.calls[4]?.[0]).toContain('callsign=BG5AAA')
    expect(fetchMock.mock.calls[4]?.[0]).not.toContain('editedOnly=')
    expect(fetchMock.mock.calls[4]?.[0]).toContain('reviewedOnly=true')
    await wrapper.findAll('button').find(button => button.text() === '清除')!.trigger('click')
    await flushPromises()
    expect(fetchMock.mock.calls[5]?.[0]).toBe('/api/admin/segments?page=1&pageSize=50')
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

    const page: SegmentPage = { items: [segment()], page: 1, pageSize: 50, total: 1 }
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

function segment(): PersistedSegment {
  return {
    calleeCallsign: null,
    callsign: 'BG5AAA',
    capturedAt: new Date().toISOString(),
    corrected: null,
    createdAt: new Date().toISOString(),
    durationMs: 1_000,
    effectiveCallsign: 'BG5AAA',
    effectiveRiskLevel: null,
    id: 'segment-1',
    manualCallsign: null,
    manualRecognition: null,
    manualNote: null,
    manualRiskLevel: null,
    nodeId: '1900',
    recognition: '这里是 BG5AAA',
    reviewed: false,
    revise: null,
    riskLevel: null,
    riskReason: null,
    voicedMs: 900,
  }
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
    status: 200,
  })
}
