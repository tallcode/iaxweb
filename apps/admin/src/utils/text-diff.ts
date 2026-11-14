export interface TextDiffPart {
  text: string
  changed: boolean
}

// Highlight only the current text. Removed AI characters are never rendered.
// Bound the LCS matrix so unusually long transcripts cannot stall the page.
export function textDiff(original: string, current: string): TextDiffPart[] {
  const before = Array.from(original)
  const after = Array.from(current)
  const parts: TextDiffPart[] = []
  const append = (text: string, changed: boolean) => {
    if (!text)
      return
    const previous = parts.at(-1)
    if (previous?.changed === changed)
      previous.text += text
    else
      parts.push({ text, changed })
  }
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start])
    start++
  let end = 0
  while (end < before.length - start && end < after.length - start && before[before.length - end - 1] === after[after.length - end - 1])
    end++
  append(after.slice(0, start).join(''), false)
  const left = before.slice(start, before.length - end)
  const right = after.slice(start, after.length - end)
  if ((left.length + 1) * (right.length + 1) > 250_000) {
    append(right.join(''), true)
  }
  else {
    const width = right.length + 1
    const lcs = new Uint32Array((left.length + 1) * width)
    for (let i = left.length - 1; i >= 0; i--) {
      for (let j = right.length - 1; j >= 0; j--)
        lcs[i * width + j] = left[i] === right[j] ? lcs[(i + 1) * width + j + 1]! + 1 : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!)
    }
    let i = 0
    let j = 0
    while (j < right.length) {
      if (i < left.length && left[i] === right[j]) {
        append(right[j]!, false)
        i++
        j++
      }
      else if (i < left.length && lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) {
        i++
      }
      else {
        append(right[j]!, true)
        j++
      }
    }
  }
  append(end ? after.slice(-end).join('') : '', false)
  return parts
}
