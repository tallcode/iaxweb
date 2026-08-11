// 手动验证音素纠错：npm run phonetic-corrector-test -- "语音识别文本"
import process from 'node:process'
import { correctExplanationText } from '../src/ai/phonetic-corrector.js'

const input = process.argv.slice(2).join(' ').trim()
if (!input) {
  console.error('用法: npm run phonetic-corrector-test -- "语音识别文本"')
  process.exit(1)
}

const result = correctExplanationText(input)
console.log(JSON.stringify({ corrected: result.text }, null, 2))
