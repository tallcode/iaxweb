import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { CallsignHintMatcher, extractCallsignFragments, formatCallsignHints, levenshteinDistance } from '../../src/ai/callsign-hints.js'

test('computes ordered Levenshtein distance without discounted transpositions', () => {
  assert.equal(levenshteinDistance('BG5ABT', 'BG5ABT'), 0)
  assert.equal(levenshteinDistance('BG5ATB', 'BG5ABT'), 2)
  assert.equal(levenshteinDistance('BG5AVT', 'BG5ABT'), 1)
})

test('extracts compact, mixed-digit, spaced and phonetic callsign fragments', () => {
  const fragments = extractCallsignFragments('BG5FVT；BG两GJJ；B G 五 G J J；Bravo Golf Five Foxtrot Bravo Tango')
  assert.ok(fragments.some(fragment => fragment.normalized === 'BG5FVT'))
  assert.ok(fragments.some(fragment => fragment.normalized === 'BG2GJJ'))
  assert.ok(fragments.some(fragment => fragment.normalized === 'BG5GJJ'))
  assert.ok(fragments.some(fragment => fragment.normalized === 'BG5FBT'))
  assert.ok(!fragments.some(fragment => fragment.normalized === 'BRAVO'))
})

test('normalizes closed-set ASR confusions before callsign matching', () => {
  const flower = extractCallsignFragments('Bravo Golf Five Foxtrot flower Tango')
  const chinese = extractCallsignFragments('Bravo Golf Five Foxtrot 布拉沃 Tango')
  const pinyin = extractCallsignFragments('Bravo Golf Five Foxtrot 补拉窝 Tango')
  const cmudict = extractCallsignFragments('alfa Golf Five Foxtrot Bravo Tango')

  assert.ok(flower.some(fragment => fragment.normalized === 'BG5FBT'))
  assert.ok(chinese.some(fragment => fragment.normalized === 'BG5FBT'))
  assert.ok(pinyin.some(fragment => fragment.normalized === 'BG5FBT'))
  assert.ok(cmudict.some(fragment => fragment.normalized === 'AG5FBT'))
})

test('normalizes English digit homophones only after a callsign prefix', () => {
  const forDigit = extractCallsignFragments('Bravo Golf for Foxtrot Bravo Tango')
  const toDigit = extractCallsignFragments('Bravo Golf to Foxtrot Bravo Tango')
  const wonDigit = extractCallsignFragments('Bravo Golf won Foxtrot Bravo Tango')

  assert.ok(forDigit.some(fragment => fragment.normalized === 'BG4FBT'))
  assert.ok(toDigit.some(fragment => fragment.normalized === 'BG2FBT'))
  assert.ok(wonDigit.some(fragment => fragment.normalized === 'BG1FBT'))
  assert.deepEqual(extractCallsignFragments('thank you for your help'), [])
  assert.deepEqual(extractCallsignFragments('please turn to four'), [])
})

test('uses normalized explanation words for known-callsign matching', () => {
  const dir = mkdtempSync(join(tmpdir(), 'iaxweb-callsigns-'))
  try {
    const path = join(dir, 'callsigns.txt')
    writeFileSync(path, 'BG5FBT\n')
    const matcher = new CallsignHintMatcher(path)

    for (const transcript of [
      'Bravo Golf Five Foxtrot flower Tango',
      'Bravo Golf Five Foxtrot 布拉沃 Tango',
    ]) {
      const exact = matcher.match(transcript)
        .flatMap(group => group.candidates)
        .find(candidate => candidate.callsign === 'BG5FBT' && candidate.distance === 0)
      assert.ok(exact, transcript)
    }
  }
  finally {
    rmSync(dir, { force: true, recursive: true })
  }
})

test('does not fuzzy-normalize unrelated prose into callsign fragments', () => {
  assert.deepEqual(extractCallsignFragments('please bring the flowers over here'), [])
})

test('keeps call-like fragments with one missing or inserted character', () => {
  const fragments = extractCallsignFragments('BG5BJ，BG35BJV')
  assert.ok(fragments.some(fragment => fragment.normalized === 'BG5BJ'))
  assert.ok(fragments.some(fragment => fragment.normalized === 'BG35BJV'))
})

test('slides across adjacent compact callsigns without separators', () => {
  const fragments = extractCallsignFragments('B75GWLBAA5AG')
  assert.ok(fragments.some(fragment => fragment.normalized === 'B75GWL'))
  assert.ok(fragments.some(fragment => fragment.normalized === 'BAA5AG'))

  const dir = mkdtempSync(join(tmpdir(), 'iaxweb-callsigns-'))
  try {
    const path = join(dir, 'callsigns.txt')
    writeFileSync(path, 'BG5GWL\nBA5AG\n')
    const candidates = new CallsignHintMatcher(path).match('B75GWLBAA5AG').flatMap(group => group.candidates)
    assert.ok(candidates.some(candidate => candidate.callsign === 'BG5GWL' && candidate.distance === 1))
    assert.ok(candidates.some(candidate => candidate.callsign === 'BA5AG' && candidate.distance === 1))
  }
  finally {
    rmSync(dir, { force: true, recursive: true })
  }
})

test('does not produce partial callsign windows from long compact runs', () => {
  const fragments = extractCallsignFragments('BG5FVT59BG5ATV')
  assert.ok(fragments.some(fragment => fragment.normalized === 'BG5FVT'))
  assert.ok(fragments.some(fragment => fragment.normalized === 'BG5ATV'))
  assert.ok(!fragments.some(fragment => fragment.normalized === 'BG5FV'))
  assert.ok(!fragments.some(fragment => fragment.normalized === 'BG5AT'))
  assert.ok(!fragments.some(fragment => fragment.normalized === 'G5ATV'))
})

test('keeps all nearby common callsigns per source fragment', (t) => {
  t.mock.method(console, 'warn', () => {})
  const dir = mkdtempSync(join(tmpdir(), 'iaxweb-callsigns-'))
  try {
    const path = join(dir, 'callsigns.txt')
    writeFileSync(path, '# 常见呼号\nBG5FBT\nbg5fat\nBG5FCT\nBG5FDT\nINVALID\n')
    const matcher = new CallsignHintMatcher(path)
    const groups = matcher.match('这里是 BG5FVT，Bravo Golf Five Foxtrot Bravo Tango')

    assert.ok(groups.length >= 2)
    assert.equal(groups[0]?.candidates[0]?.callsign, 'BG5FBT')
    assert.equal(groups[0]?.candidates[0]?.distance, 0)
    assert.equal(groups[0]?.candidates[0]?.score, 1)
    assert.ok(groups.some(group => group.candidates.length === 4))
    assert.ok(groups.flatMap(group => group.candidates).every(candidate => candidate.callsign !== 'INVALID'))

    const formatted = formatCallsignHints(groups)
    assert.ok(formatted?.includes('原文片段“BG5FVT”'))
    assert.ok(formatted?.includes('BG5FBT（距离 1）'))
    assert.ok(!formatted?.includes('BG5FBT（距离 0）'))
  }
  finally {
    rmSync(dir, { force: true, recursive: true })
  }
})

test('rejects reordered equal-length suffixes while allowing an inserted or missing character', () => {
  const dir = mkdtempSync(join(tmpdir(), 'iaxweb-callsigns-'))
  try {
    const path = join(dir, 'callsigns.txt')
    writeFileSync(path, 'BG5FVT\nBG5BJV\nBG5GWP\n')
    const matcher = new CallsignHintMatcher(path)

    assert.deepEqual(matcher.match('BG5FTV'), [])
    assert.equal(matcher.match('BG35BJV')[0]?.candidates[0]?.callsign, 'BG5BJV')
    assert.equal(matcher.match('G5GWP')[0]?.candidates[0]?.callsign, 'BG5GWP')
  }
  finally {
    rmSync(dir, { force: true, recursive: true })
  }
})

test('hot-reloads the common callsign list', () => {
  const dir = mkdtempSync(join(tmpdir(), 'iaxweb-callsigns-'))
  try {
    const path = join(dir, 'callsigns.txt')
    const matcher = new CallsignHintMatcher(path)

    writeFileSync(path, 'BG5FBT\n')
    assert.equal(matcher.match('BG5FVT')[0]?.candidates[0]?.callsign, 'BG5FBT')

    writeFileSync(path, 'BG5FAT\n')
    assert.equal(matcher.match('BG5FVT')[0]?.candidates[0]?.callsign, 'BG5FAT')
  }
  finally {
    rmSync(dir, { force: true, recursive: true })
  }
})

test('returns no hints when the transcript has no nearby callsign fragment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'iaxweb-callsigns-'))
  try {
    const path = join(dir, 'callsigns.txt')
    writeFileSync(path, 'BG5FBT\n')
    assert.deepEqual(new CallsignHintMatcher(path).match('收到，谢谢，再见'), [])
  }
  finally {
    rmSync(dir, { force: true, recursive: true })
  }
})

test('formats each source fragment at its own minimum correction distance', () => {
  const hints = formatCallsignHints([
    {
      candidates: [
        { callsign: 'BG5AAA', distance: 2, score: 0.667 },
        { callsign: 'BG5AAB', distance: 1, score: 0.833 },
        { callsign: 'BG5AAC', distance: 1, score: 0.833 },
      ],
      source: 'BG5AAD',
    },
    {
      candidates: [{ callsign: 'BG5AAB', distance: 1, score: 0.833 }],
      source: '重复片段',
    },
  ])

  assert.equal(hints, [
    '常见呼号相似度候选：',
    '- 原文片段“BG5AAD”：BG5AAB（距离 1）',
    '- 原文片段“BG5AAD”：BG5AAC（距离 1）',
  ].join('\n'))
})

test('does not give exact library matches to the LLM', () => {
  const hints = formatCallsignHints([
    {
      candidates: [
        { callsign: 'BG5AAA', distance: 0, score: 1 },
        { callsign: 'BG5AAB', distance: 1, score: 0.833 },
      ],
      source: 'BG5AAA',
    },
    {
      candidates: [{ callsign: 'BG5BBB', distance: 0, score: 1 }],
      source: 'BG5BBB',
    },
  ])

  assert.equal(hints, undefined)
})

test('does not let an exact callee hide a one-character caller correction', () => {
  const hints = formatCallsignHints([
    { candidates: [{ callsign: 'BG5ATV', distance: 0, score: 1 }], source: 'BG5ATV' },
    { candidates: [{ callsign: 'BG5FBT', distance: 1, score: 0.833 }], source: 'BG5FVT' },
  ])

  assert.equal(hints, [
    '常见呼号相似度候选：',
    '- 原文片段“BG5FVT”：BG5FBT（距离 1）',
  ].join('\n'))
})

test('does not give the LLM candidates when the minimum distance is greater than one', () => {
  assert.equal(formatCallsignHints([{
    candidates: [{ callsign: 'BG5AAA', distance: 2, score: 0.667 }],
    source: 'BG35AAX',
  }]), undefined)
})
