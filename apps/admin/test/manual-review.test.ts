// @vitest-environment jsdom
import type { AdminRecord, PersistedRecord } from '@iaxweb/contracts'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { adminSession } from '../src/admin-session'
import CallsignText from '../src/components/records/CallsignText.vue'
import RecordsPage from '../src/pages/RecordsPage.vue'

vi.mock('vue-router', () => ({ useRouter: () => ({ replace: vi.fn() }), RouterLink: 'a' }))

afterEach(() => {
  adminSession.value = null
  vi.unstubAllGlobals()
})

function record(): AdminRecord {
  return {
    hasAudio: false,
    id: 'review-row',
    nodeId: '1900',
    capturedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    durationMs: 1000,
    voicedMs: 900,
    recognition: '这里是 BG5AAA',
    corrected: null,
    revise: null,
    callsign: 'BG5AAA',
    effectiveCallsign: 'BG5AAA',
    manualCallsign: null,
    calleeCallsign: null,
    manualRecognition: null,
    reviewed: false,
    manualNote: null,
    manualRiskLevel: null,
    riskLevel: null,
    effectiveRiskLevel: null,
    riskReason: null,
  }
}

function setup(row: PersistedRecord, ...responses: Response[]) {
  adminSession.value = { role: 'admin', username: 'admin' }
  vi.stubGlobal('Audio', class extends EventTarget {
    load(): void {}
    pause(): void {}
    removeAttribute(): void {}
  })
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ items: [row], total: 1, page: 1, pageSize: 50 }))
  for (const response of responses)
    fetchMock.mockResolvedValueOnce(response)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

it('saves human text separately and clears it back to the white AI display', async () => {
  const row = record()
  const edited = { ...row, manualRecognition: '这里是 BG5BBB' }
  const fetchMock = setup(row, Response.json(edited), Response.json(row))
  const wrapper = mount(RecordsPage)
  await flushPromises()
  await wrapper.get('button[aria-label="编辑识别文本"]').trigger('click')
  await wrapper.get('textarea').setValue(edited.manualRecognition)
  await wrapper.get('textarea').trigger('keydown', { key: 'Enter' })
  await flushPromises()
  const display = wrapper.get('button[aria-label="编辑识别文本"]')
  expect(display.text()).toBe(edited.manualRecognition)
  expect(display.classes()).toContain('text-emerald-400')
  expect(display.findAll('span').some(span => span.classes().includes('bg-yellow-200/25'))).toBe(true)
  expect(fetchMock.mock.calls[1]?.[1].body).toBe(JSON.stringify({ recognition: edited.manualRecognition }))
  expect(wrapper.get('tbody button[aria-label="标注记录"]').attributes('aria-pressed')).toBe('false')
  await display.trigger('click')
  await wrapper.get('textarea').setValue('')
  await wrapper.get('textarea').trigger('keydown', { key: 'Enter' })
  await flushPromises()
  expect(wrapper.get('button[aria-label="编辑识别文本"]').text()).toBe(row.recognition)
  expect(wrapper.get('button[aria-label="编辑识别文本"]').classes()).toContain('text-slate-100')
  expect(fetchMock.mock.calls[2]?.[1].body).toBe(JSON.stringify({ recognition: null }))
  wrapper.unmount()
})

it('persists review and cancel actions and rolls back a failed save', async () => {
  const row = record()
  const fetchMock = setup(row, Response.json({ ...row, reviewed: true }), new Response('failed', { status: 500 }), Response.json(row))
  const wrapper = mount(RecordsPage)
  await flushPromises()
  const star = wrapper.get('tbody button[aria-label="标注记录"]')
  expect(star.get('svg').attributes('fill')).toBe('none')
  await star.trigger('click')
  await flushPromises()
  expect(star.attributes('aria-pressed')).toBe('true')
  expect(star.get('svg').attributes('fill')).toBe('currentColor')
  expect(star.classes()).toContain('text-emerald-400')
  expect(wrapper.get('tbody tr').classes()).toContain('bg-emerald-950/40')
  await star.trigger('click')
  await flushPromises()
  expect(star.attributes('aria-pressed')).toBe('true')
  expect(star.get('svg').attributes('fill')).toBe('currentColor')
  expect(star.classes()).toContain('text-emerald-400')
  await star.trigger('click')
  await flushPromises()
  expect(star.attributes('aria-pressed')).toBe('false')
  expect(star.get('svg').attributes('fill')).toBe('none')
  expect(wrapper.get('tbody tr').classes()).not.toContain('bg-emerald-950/40')
  expect(fetchMock.mock.calls.slice(1).map(call => JSON.parse(call[1].body))).toEqual([{ reviewed: true }, { reviewed: false }, { reviewed: false }])
  wrapper.unmount()
})

it.each([
  { callsign: null, manualCallsign: null, effectiveCallsign: null, disabled: true },
  { callsign: 'BG5AAA', manualCallsign: null, effectiveCallsign: 'BG5AAA', disabled: false },
  { callsign: null, manualCallsign: 'BG5BBB', effectiveCallsign: 'BG5BBB', disabled: false },
])('requires either AI or manual caller on desktop and mobile: $effectiveCallsign', async ({ disabled, ...callers }) => {
  const fetchMock = setup({ ...record(), ...callers })
  const wrapper = mount(RecordsPage)
  await flushPromises()
  const stars = wrapper.findAll('button[aria-label="标注记录"]')
  expect(stars).toHaveLength(2)
  for (const star of stars) {
    expect(star.attributes('disabled') !== undefined).toBe(disabled)
    if (disabled) {
      expect(star.attributes('title')).toContain('请先填写主叫呼号')
      await star.trigger('click')
    }
  }
  expect(fetchMock).toHaveBeenCalledTimes(1)
  wrapper.unmount()
})

it('allows cancelling an existing empty-caller legacy review', async () => {
  const row = { ...record(), callsign: null, manualCallsign: null, effectiveCallsign: null, reviewed: true }
  setup(row, Response.json({ ...row, reviewed: false }))
  const wrapper = mount(RecordsPage)
  await flushPromises()
  const star = wrapper.get('tbody button[aria-label="标注记录"]')
  expect(star.attributes('disabled')).toBeUndefined()
  await star.trigger('click')
  await flushPromises()
  expect(star.attributes('aria-pressed')).toBe('false')
  expect(star.attributes('disabled')).toBeDefined()
  wrapper.unmount()
})

it('renders a manually rejected AI callsign in white with a strike and yellow background', () => {
  const wrapper = mount(CallsignText, { props: { original: 'BD1ESL', manual: 'N0CALL' } })
  expect(wrapper.get('del').text()).toBe('BD1ESL')
  expect(wrapper.get('del').classes()).toEqual(expect.arrayContaining(['text-slate-100', 'bg-yellow-200/25']))
  wrapper.unmount()
})
