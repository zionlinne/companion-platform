export type MemoryCategory = 'persona' | 'fact' | 'event' | 'relationship'

export type ImportItem = {
  tempId: string
  category: MemoryCategory
  content: string
  source: string
  explicit: boolean
  note: string
}

const categories = new Set<MemoryCategory>(['persona', 'fact', 'event', 'relationship'])

const asCategory = (value: unknown, fallback: MemoryCategory): MemoryCategory =>
  typeof value === 'string' && categories.has(value as MemoryCategory) ? (value as MemoryCategory) : fallback

const clean = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

let seq = 0
const tempId = () => `tmp_${++seq}`

export function resetImportIds(): void {
  seq = 0
}

function item(
  category: MemoryCategory,
  content: string,
  source: string,
  explicit: boolean,
  note: string
): ImportItem | null {
  const text = content.trim()
  if (!text) return null
  return { tempId: tempId(), category, content: text.slice(0, 4000), source, explicit, note }
}

function fromObjects(rows: unknown[], source: string, explicitDefault: boolean, note: string): ImportItem[] {
  const items: ImportItem[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const record = row as Record<string, unknown>
    const content = clean(record.content ?? record.text ?? record.memory)
    const made = item(asCategory(record.category, 'fact'), content, clean(record.source) || source, record.explicit === true ? true : explicitDefault, note)
    if (made) items.push(made)
  }
  return items
}

function parseJsonValue(text: string): ImportItem[] {
  const parsed = JSON.parse(text) as unknown
  if (Array.isArray(parsed)) return fromObjects(parsed, 'json', true, 'Imported from JSON. Confirm before saving.')
  if (parsed && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>
    if (Array.isArray(record.memories)) return fromObjects(record.memories, 'json', true, 'Imported from JSON. Confirm before saving.')
    if (record.mapping && typeof record.mapping === 'object') return chatgptMapping(record.mapping)
    if (record.chunkedPrompt && typeof record.chunkedPrompt === 'object') return geminiChunks(record.chunkedPrompt)
    if (Array.isArray(record.messages)) return messageFragments(record.messages, 'deepseek-session-json')
  }
  throw new Error('unrecognized_export')
}

function chatgptMapping(mapping: unknown): ImportItem[] {
  const items: ImportItem[] = []
  if (!mapping || typeof mapping !== 'object') return items
  for (const node of Object.values(mapping as Record<string, unknown>)) {
    if (!node || typeof node !== 'object') continue
    const message = (node as { message?: { content?: { parts?: unknown[] } } }).message
    const parts = message?.content?.parts
    if (!Array.isArray(parts)) continue
    for (const part of parts) {
      if (typeof part !== 'string') continue
      const made = item('event', part, 'chatgpt-export', false, 'Extracted text, not a verified fact. Confirm before saving.')
      if (made) items.push(made)
    }
  }
  return items
}

function geminiChunks(chunked: unknown): ImportItem[] {
  const chunks = (chunked as { chunks?: unknown[] }).chunks
  if (!Array.isArray(chunks)) return []
  return chunks.flatMap((chunk) => {
    if (!chunk || typeof chunk !== 'object') return []
    const text = clean((chunk as { text?: unknown }).text)
    const made = item('event', text, 'gemini-export', false, 'Extracted text, not a verified fact. Confirm before saving.')
    return made ? [made] : []
  })
}

function messageFragments(messages: unknown[], source: string): ImportItem[] {
  const items: ImportItem[] = []
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    const fragments = (message as { fragments?: unknown[] }).fragments
    if (Array.isArray(fragments)) {
      for (const fragment of fragments) {
        if (!fragment || typeof fragment !== 'object') continue
        const kind = (fragment as { type?: string }).type
        if (kind !== 'REQUEST' && kind !== 'RESPONSE') continue
        const made = item('event', clean((fragment as { content?: unknown }).content), source, false, 'Extracted conversation text, not a verified fact.')
        if (made) items.push(made)
      }
    }
  }
  return items
}

function parseJsonl(text: string): ImportItem[] {
  const rows = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown)
  return fromObjects(rows, 'jsonl', true, 'Imported from JSONL. Confirm before saving.')
}

function parseMarkdown(text: string): ImportItem[] {
  const items: ImportItem[] = []
  let category: MemoryCategory = 'fact'
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const heading = /^#{1,3}\s+(persona|fact|event|relationship)\b/i.exec(line)
    if (heading) {
      category = heading[1].toLowerCase() as MemoryCategory
      continue
    }
    if (!line || line.startsWith('#')) continue
    const made = item(category, line.replace(/^[-*]\s+/, ''), 'markdown', true, 'Imported from Markdown. Confirm before saving.')
    if (made) items.push(made)
  }
  return items
}

function parseText(text: string): ImportItem[] {
  const items: ImportItem[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const tagged = /^(persona|fact|event|relationship)\s*[:：]\s*(.+)$/i.exec(line)
    if (tagged) {
      const made = item(tagged[1].toLowerCase() as MemoryCategory, tagged[2], 'text', true, 'Imported from text. Confirm before saving.')
      if (made) items.push(made)
    } else {
      const made = item('fact', line, 'text', false, 'Untagged line kept as an unconfirmed fact. Confirm before saving.')
      if (made) items.push(made)
    }
  }
  return items
}

export function parseMemoryImport(format: string, text: string): ImportItem[] {
  resetImportIds()
  const body = text.trim()
  if (!body) return []
  if (format === 'json') return parseJsonValue(body)
  if (format === 'jsonl') return parseJsonl(body)
  if (format === 'md') return parseMarkdown(body)
  if (format === 'txt') return parseText(body)
  if (format === 'chatgpt') return parseJsonValue(body)
  if (format === 'gemini') return parseJsonValue(body)
  if (format === 'deepseek') {
    if (body.startsWith('PK') || body.includes('export_format_version')) {
      throw new Error('deepseek_zip_not_supported')
    }
    return parseJsonValue(body)
  }
  throw new Error('unsupported_format')
}

export function dedupeImports(items: ImportItem[], existing: Array<{ category: string; content: string }>): {
  accepted: ImportItem[]
  duplicates: ImportItem[]
} {
  const seen = new Set(existing.map((row) => `${row.category}\n${row.content.trim().toLowerCase()}`))
  const accepted: ImportItem[] = []
  const duplicates: ImportItem[] = []
  for (const item of items) {
    const key = `${item.category}\n${item.content.trim().toLowerCase()}`
    if (seen.has(key)) duplicates.push(item)
    else {
      seen.add(key)
      accepted.push(item)
    }
  }
  return { accepted, duplicates }
}
