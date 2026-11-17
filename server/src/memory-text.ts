const STOP = new Set([
  '今天', '这个', '那个', '我们', '你们', '他们', '什么', '怎么', '因为', '所以', '然后', '还是',
  '一个', '没有', '不是', '可以', '知道', '觉得', '自己', '已经', '如果', '但是', '而且', '或者',
  '现在', '以后', '就是', '这个', '一下', '什么', '怎么', '因为',
])

export function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/[\s"'“”‘’.,，。！？!?:：;；、]/g, '')
}

export function grams(text: string): Set<string> {
  const lower = text.toLowerCase()
  const set = new Set<string>()
  for (const word of lower.match(/[a-z0-9][a-z0-9_+.-]{1,}/g) ?? []) set.add(word)
  const compact = lower.replace(/\s+/g, '')
  for (let index = 0; index < compact.length - 1; index += 1) set.add(compact.slice(index, index + 2))
  return set
}

function distinctive(text: string): Set<string> {
  const out = new Set<string>()
  for (const gram of grams(text)) {
    if (gram.length < 2 || STOP.has(gram)) continue
    out.add(gram)
  }
  return out
}

function overlap(left: string, right: string): { shared: number; left: number; right: number } {
  const a = distinctive(left)
  const b = distinctive(right)
  let shared = 0
  for (const gram of a) if (b.has(gram)) shared += 1
  return { shared, left: a.size, right: b.size }
}

export function relevance(left: string, right: string): number {
  const score = overlap(left, right)
  if (!score.shared || !score.left || !score.right) return 0
  return score.shared / (score.left + score.right - score.shared)
}

export function retrievalScore(topic: string, content: string): number {
  const score = overlap(topic, content)
  if (!score.shared || !score.left) return 0
  return score.shared / score.left
}

export function sameMemory(left: string, right: string): boolean {
  const a = normalizeText(left)
  const b = normalizeText(right)
  if (!a || !b) return false
  if (a === b) return true
  return relevance(left, right) >= 0.9
}

export function locateScore(hint: string, content: string): number {
  const needle = normalizeText(hint)
  const haystack = normalizeText(content)
  if (!needle || !haystack) return 0
  if (haystack.includes(needle) || needle.includes(haystack)) return 0.95
  return relevance(hint, content)
}
