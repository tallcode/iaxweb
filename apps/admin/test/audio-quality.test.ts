// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import RecordDuration from '../src/components/records/RecordDuration.vue'

describe('record duration quality', () => {
  it('shows passed duration in white and historical skip in gray without icons', async () => {
    const wrapper = mount(RecordDuration, { props: { durationMs: 9220, quality: { status: 'passed', reason: null, metrics: null } } })
    expect(wrapper.text()).toBe('9.2s')
    expect(wrapper.classes()).toContain('text-white')
    expect(wrapper.attributes('title')).toBe('语音质量良好')
    await wrapper.setProps({ quality: { status: 'skip', reason: null, metrics: null } })
    expect(wrapper.classes()).toContain('text-slate-500')
    expect(wrapper.attributes('title')).toContain('历史记录')
    expect(wrapper.find('svg').exists()).toBe(false)
    wrapper.unmount()
  })

  it('shows rejected duration in gray with quality details on hover and no interactive icon', () => {
    const wrapper = mount(RecordDuration, { props: { durationMs: 9220, quality: { status: 'rejected', reason: 'interference_high_band', metrics: null } } })
    expect(wrapper.attributes('title')).toBe('语音质量较差：高频噪声较明显。')
    expect(wrapper.classes()).toContain('text-slate-500')
    expect(wrapper.find('svg').exists()).toBe(false)
    expect(wrapper.text()).toBe('9.2s')
    expect(wrapper.find('button').exists()).toBe(false)
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('shows unknown duration in gray with the failed check reason', () => {
    const wrapper = mount(RecordDuration, { props: { durationMs: 9220, quality: { status: 'unknown', reason: 'check_failed', metrics: null } } })
    expect(wrapper.classes()).toContain('text-slate-500')
    expect(wrapper.attributes('title')).toBe('语音质量未知：检查失败，可手动重试。')
    wrapper.unmount()
  })
})
