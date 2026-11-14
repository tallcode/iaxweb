import { describe, expect, it } from 'vitest'
import { textDiff } from '../src/utils/text-diff'

describe('manual text differences', () => {
  it('highlights replacements while retaining shared letters', () => {
    expect(textDiff('BG5GXT', 'BG5GZF')).toEqual([{ text: 'BG5G', changed: false }, { text: 'ZF', changed: true }])
  })
  it('does not display deleted AI characters or split Unicode characters', () => {
    expect(textDiff('这里是，呃，BG5AAA📻', '这里是BG5AAA📻')).toEqual([{ text: '这里是BG5AAA📻', changed: false }])
    expect(textDiff('📻', '📻好')).toEqual([{ text: '📻', changed: false }, { text: '好', changed: true }])
  })
  it('bounds work on long replacements and preserves the exact edited text', () => {
    const current = `头${'乙'.repeat(1000)}尾`
    const result = textDiff(`头${'甲'.repeat(1000)}尾`, current)
    expect(result.map(part => part.text).join('')).toBe(current)
    expect(result).toEqual([{ text: '头', changed: false }, { text: '乙'.repeat(1000), changed: true }, { text: '尾', changed: false }])
  })
})
