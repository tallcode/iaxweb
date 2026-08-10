import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { AiConfigFiles, validateHotwords } from '../../src/ai/context-store.js'

test('validates hotword entries', (t) => {
  t.mock.method(console, 'warn', () => {})
  assert.deepEqual(
    validateHotwords({ CQ: 5, 抄收: 4, 超热词: 50 }),
    { CQ: 5, 抄收: 4, 超热词: 50 },
  )
  assert.equal(validateHotwords({}), undefined)
  assert.equal(validateHotwords(['CQ']), undefined)
  assert.equal(validateHotwords({ CQ: 6 }), undefined)
  assert.equal(validateHotwords({ CQ: 0 }), undefined)
  assert.equal(validateHotwords({ CQ: 1.5 }), undefined)
  assert.equal(validateHotwords({ '': 5 }), undefined)
})

test('enforces hotword text length rules', (t) => {
  t.mock.method(console, 'warn', () => {})
  // Non-ASCII entries are limited to 15 characters.
  assert.equal(validateHotwords({ 词词词词词词词词词词词词词词词词: 4 }), undefined)
  assert.deepEqual(validateHotwords({ 词词词词词词词词词词词词词词词: 4 }), { 词词词词词词词词词词词词词词词: 4 })
  // ASCII entries are limited to 7 space-separated parts.
  assert.equal(validateHotwords({ 'a b c d e f g h': 4 }), undefined)
  assert.deepEqual(validateHotwords({ 'a b c d e f g': 4 }), { 'a b c d e f g': 4 })
})

test('caps the number of super hotwords', (t) => {
  t.mock.method(console, 'warn', () => {})
  const hotwords: Record<string, number> = {}
  for (let index = 0; index < 51; index++)
    hotwords[`W${index}`] = 50
  const validated = validateHotwords(hotwords)
  assert.ok(validated)
  assert.equal(Object.keys(validated).length, 50)
})

test('caps the total number of hotwords', (t) => {
  t.mock.method(console, 'warn', () => {})
  const hotwords: Record<string, number> = {}
  for (let index = 0; index < 2_001; index++)
    hotwords[`词${index}`] = 3
  const validated = validateHotwords(hotwords)
  assert.ok(validated)
  assert.equal(Object.keys(validated).length, 2_000)
})

test('reloads hotword and background files on every read', (t) => {
  t.mock.method(console, 'warn', () => {})
  const dir = mkdtempSync(join(tmpdir(), 'iaxweb-ai-'))
  try {
    const hotwordsPath = join(dir, 'hotwords.json')
    const backgroundPath = join(dir, 'background.txt')
    const files = new AiConfigFiles(hotwordsPath, backgroundPath)

    assert.equal(files.hotwords(), undefined)
    assert.equal(files.background(), undefined)

    writeFileSync(hotwordsPath, JSON.stringify({ CQ: 5 }))
    writeFileSync(backgroundPath, '背景文字')
    assert.deepEqual(files.hotwords(), { CQ: 5 })
    assert.equal(files.background(), '背景文字')

    writeFileSync(hotwordsPath, JSON.stringify({ 签到: 4 }))
    assert.deepEqual(files.hotwords(), { 签到: 4 })

    // A broken edit keeps the last good table instead of dropping hotwords.
    writeFileSync(hotwordsPath, '{oops')
    assert.deepEqual(files.hotwords(), { 签到: 4 })

    // Entries failing validation are skipped, valid ones survive.
    writeFileSync(hotwordsPath, JSON.stringify({ 呼叫: 3, 坏权重: 9 }))
    assert.deepEqual(files.hotwords(), { 呼叫: 3 })

    writeFileSync(backgroundPath, '')
    assert.equal(files.background(), undefined)
  }
  finally {
    rmSync(dir, { force: true, recursive: true })
  }
})

test('truncates background text at the context limit', (t) => {
  t.mock.method(console, 'warn', () => {})
  const dir = mkdtempSync(join(tmpdir(), 'iaxweb-ai-'))
  try {
    const backgroundPath = join(dir, 'background.txt')
    const files = new AiConfigFiles(join(dir, 'missing.json'), backgroundPath)
    writeFileSync(backgroundPath, '字'.repeat(450))
    const background = files.background()
    assert.ok(background)
    assert.equal(background.length, 400)
  }
  finally {
    rmSync(dir, { force: true, recursive: true })
  }
})
