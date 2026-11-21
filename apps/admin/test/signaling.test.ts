// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import RecognitionEditor from '../src/components/records/RecognitionEditor.vue'

describe('record signaling indicator', () => {
  it('shows protocol/content after the text and hides the indicator while editing', async () => {
    const wrapper = mount(RecognitionEditor, {
      props: { original: 'transcript', manual: null, disabled: false, signals: [{ type: 'BSS', content: 'N0CALL' }], save: vi.fn().mockResolvedValue(true) },
    })
    expect(wrapper.get('[role="img"]').attributes('title')).toBe('BSS\nN0CALL')
    await wrapper.get('[role="img"]').trigger('click')
    expect(wrapper.find('textarea').exists()).toBe(false)
    await wrapper.get('button').trigger('click')
    expect(wrapper.find('textarea').exists()).toBe(true)
    expect(wrapper.find('[role="img"]').exists()).toBe(false)
    await wrapper.get('textarea').trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('[role="img"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('keeps the tooltip available for read-only records and omits it for empty results', async () => {
    const wrapper = mount(RecognitionEditor, {
      props: { original: 'transcript', manual: null, disabled: false, readOnly: true, signals: [{ type: 'MDC1200', content: 'ID 0x1234' }], save: vi.fn() },
    })
    expect(wrapper.get('[role="img"]').attributes('title')).toBe('MDC1200\nID 0x1234')
    await wrapper.setProps({ signals: [] })
    expect(wrapper.find('[role="img"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
