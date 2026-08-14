// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import LoginPage from '../src/pages/LoginPage.vue'

const replace = vi.fn()

vi.mock('vue-router', () => ({
  useRouter: () => ({ replace }),
}))

afterEach(() => {
  replace.mockReset()
  vi.unstubAllGlobals()
})

describe('admin login', () => {
  it('recovers the submit button after a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const wrapper = mount(LoginPage)

    await wrapper.get('input[autocomplete="username"]').setValue('admin')
    await wrapper.get('input[autocomplete="current-password"]').setValue('secret')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(wrapper.text()).toContain('无法连接服务器')
    expect(wrapper.get('button').attributes('disabled')).toBeUndefined()
  })

  it('shows a specific message when login attempts are limited', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 429 })))
    const wrapper = mount(LoginPage)

    await wrapper.get('input[autocomplete="username"]').setValue('admin')
    await wrapper.get('input[autocomplete="current-password"]').setValue('secret')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(wrapper.text()).toContain('登录尝试过多')
    expect(replace).not.toHaveBeenCalled()
  })
})
