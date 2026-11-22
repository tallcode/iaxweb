// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import AudioQualityIndicator from '../src/components/records/AudioQualityIndicator.vue'

describe('audio quality indicator', () => {
  it('hides passed and historical skip quality', async () => {
    const wrapper = mount(AudioQualityIndicator, { props: { quality: { status: 'passed', reason: null, metrics: null } } })
    expect(wrapper.find('button').exists()).toBe(false)
    await wrapper.setProps({ quality: { status: 'skip', reason: null, metrics: null } })
    expect(wrapper.find('button').exists()).toBe(false)
    wrapper.unmount()
  })

  it('shows only an SVG and simple quality message for rejected audio, with a tappable tooltip', async () => {
    const wrapper = mount(AudioQualityIndicator, { props: { quality: { status: 'rejected', reason: 'interference_high_band', metrics: null } } })
    expect(wrapper.get('button').attributes('title')).toBe('语音质量较差')
    expect(wrapper.find('svg').exists()).toBe(true)
    expect(wrapper.text()).toBe('')
    await wrapper.get('button').trigger('click')
    expect(document.querySelector('[role="tooltip"]')?.textContent?.trim()).toBe('语音质量较差')
    expect(document.body.textContent).not.toContain('interference_high_band')
    wrapper.unmount()
  })

  it('uses an unknown indicator when quality checking failed', () => {
    const wrapper = mount(AudioQualityIndicator, { props: { quality: { status: 'unknown', reason: 'check_failed', metrics: null } } })
    expect(wrapper.get('button').attributes('aria-label')).toBe('暂无质量检查结果')
    wrapper.unmount()
  })
})
