import assert from 'node:assert/strict'
import test from 'node:test'

import { cmuPhones, correctChineseWord, correctEnglishWord, correctExplanationText, correctExplanationWord, featurePhoneDistance, pinyinSyllables, tokenDistance } from '../../src/ai/phonetic-corrector.js'

test('reads stress-free ARPABET phones from CMUdict', () => {
  assert.deepEqual(cmuPhones('bravo'), ['B', 'R', 'AA', 'V', 'OW'])
  assert.deepEqual(cmuPhones('alfa'), cmuPhones('alpha'))
  assert.equal(cmuPhones('brabo'), undefined)
})

test('corrects English words by CMUdict phone distance', () => {
  assert.deepEqual(correctEnglishWord('alfa'), {
    canonical: 'alpha',
    distance: 0,
    language: 'en',
    matched: 'alpha',
    method: 'cmudict',
    symbol: 'A',
  })
  assert.equal(correctEnglishWord('brabo'), undefined)
})

test('keeps explicit aliases for ASR-specific non-phonetic errors', () => {
  assert.deepEqual(correctExplanationWord('flower'), {
    canonical: 'bravo',
    distance: 0,
    language: 'en',
    matched: 'bravo',
    method: 'alias',
    symbol: 'B',
  })
})

test('corrects Chinese characters through tone-free pinyin', () => {
  assert.deepEqual(pinyinSyllables('补拉窝'), ['bu', 'la', 'wo'])
  assert.deepEqual(pinyinSyllables('布拉沃'), ['bu', 'la', 'wo'])
  assert.deepEqual(correctChineseWord('补拉窝'), {
    canonical: 'bravo',
    distance: 0,
    language: 'zh',
    matched: '布拉沃',
    method: 'pinyin',
    symbol: 'B',
  })
})

test('measures phone and pinyin sequences by token, not characters', () => {
  assert.equal(tokenDistance(['AA', 'V', 'OW'], ['AA', 'F', 'OW']), 1)
  assert.equal(tokenDistance(['bu', 'la', 'wo'], ['bu', 'la', 'wo']), 0)
  assert.equal(tokenDistance(['bu', 'la', 'wo'], ['bu', 'wo']), 1)
})

test('does not pull unrelated words into the explanation set', () => {
  assert.equal(correctExplanationWord('received'), undefined)
  assert.equal(correctExplanationWord('收到谢谢'), undefined)
})

test('corrects a complete transcript while preserving unrelated text', () => {
  assert.deepEqual(correctExplanationText('这里是 Bravo Golf Five Foxtrot 补拉窝 Tango，f。'), {
    corrections: [{
      canonical: 'bravo',
      distance: 0,
      language: 'zh',
      matched: '布拉沃',
      method: 'pinyin',
      source: '补拉窝',
      symbol: 'B',
    }],
    text: '这里是 Bravo Golf Five Foxtrot Bravo Tango，f。',
  })
})

test('does not correct ordinary Chinese particles to explanation words', () => {
  assert.equal(correctChineseWord('吗'), undefined)
  assert.deepEqual(correctExplanationText('是吗？'), { corrections: [], text: '是吗？' })
})

test('uses a sliding English phone window only inside an explanation-word context', () => {
  assert.equal(featurePhoneDistance(['TH', 'AE', 'NG', 'K', 'Y', 'UW'], ['T', 'AE', 'NG', 'G', 'OW']), 1)
  assert.deepEqual(correctExplanationText('Bravo Germany Five Foxtrot Bravo, thank you'), {
    corrections: [{
      canonical: 'tango',
      distance: 1,
      language: 'en',
      matched: 'tango',
      method: 'cmudict-window',
      source: 'thank you',
      symbol: 'T',
    }],
    text: 'Bravo Germany Five Foxtrot Bravo, Tango',
  })
  assert.deepEqual(correctExplanationText('thank you for your help'), { corrections: [], text: 'thank you for your help' })
})
