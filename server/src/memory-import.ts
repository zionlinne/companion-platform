export type MemoryCategory = 'persona' | 'fact' | 'event' | 'relationship'

export const MEMORY_PACKAGE_KIND = 'companion-platform-memory-package'
export const MEMORY_PACKAGE_VERSION = 1

export type ImportItem = {
  tempId: string
  category: MemoryCategory
  content: string
  source: string
  explicit: boolean
  note: string
  createdAt: string | null
  updatedAt: string | null
}

export type PortableMemory = {
  category: MemoryCategory
  content: string
  source: string
  explicit: boolean
  note: string
  createdAt: string
  updatedAt: string
}

const categories = new Set<MemoryCategory>(['persona', 'fact', 'event', 'relationship'])

const asCategory = (value: unknown, fallback: MemoryCategory): MemoryCategory =>
  typeof value === 'string' && categories.has(value as MemoryCategory) ? (value as MemoryCategory) : fallback

const clean = (value: unknown, max = 4000) => (typeof value === 'string' ? value.trim().slice(0, max) : '')

let seq = 0
const tempId = () => `tmp_${++seq}`

export function resetImportIds(): void {
  seq = 0
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value)) return null
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return null
  return new Date(time).toISOString()
}

function item(input: {
  category: MemoryCategory
  content: string
  source: string
  explicit: boolean
  note: string
  createdAt?: string | null
  updatedAt?: string | null
}): ImportItem | null {
  const content = input.content.trim().slice(0, 4000)
  if (!content) return null
  return {
    tempId: tempId(),
    category: input.category,
    content,
    source: input.source.trim().slice(0, 200) || 'import',
    explicit: input.explicit,
    note: input.note.trim().slice(0, 500),
    createdAt: input.createdAt ?? null,
    updatedAt: input.updatedAt ?? null,
  }
}

function fromObjects(rows: unknown[], source: string, explicitDefault: boolean, note: string): ImportItem[] {
  const items: ImportItem[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const record = row as Record<string, unknown>
    const content = clean(record.content ?? record.text ?? record.memory)
    const explicit = typeof record.explicit === 'boolean' ? record.explicit : explicitDefault
    const made = item({
      category: asCategory(record.category, 'fact'),
      content,
      source: clean(record.source, 200) || source,
      explicit,
      note: clean(record.note, 500) || note,
      createdAt: isoOrNull(record.createdAt),
      updatedAt: isoOrNull(record.updatedAt),
    })
    if (made) items.push(made)
  }
  return items
}

function rejectPersonaMix(record: Record<string, unknown>): void {
  if (record.kind === 'companion-platform-character' || record.character) {
    throw new Error('character_card_not_memory')
  }
  if ('identity' in record || 'rules' in record || 'traits' in record || 'background' in record) {
    throw new Error('persona_mixed_into_memory')
  }
}

function parsePackage(record: Record<string, unknown>): ImportItem[] {
  rejectPersonaMix(record)
  if (record.kind !== MEMORY_PACKAGE_KIND) throw new Error('not_memory_package')
  if (record.version !== MEMORY_PACKAGE_VERSION) throw new Error('unsupported_package_version')
  if (!Array.isArray(record.memories)) throw new Error('not_memory_package')
  return fromObjects(record.memories, 'memory-package', false, '')
}

function parseJsonValue(parsed: unknown): ImportItem[] {
  if (Array.isArray(parsed)) return fromObjects(parsed, 'json', true, 'Imported from JSON. Confirm before saving.')
  if (parsed && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>
    if (record.kind === MEMORY_PACKAGE_KIND) return parsePackage(record)
    rejectPersonaMix(record)
    if (Array.isArray(record.memories)) {
      return fromObjects(record.memories, 'json', true, 'Imported from JSON. Confirm before saving.')
    }
  }
  throw new Error('unrecognized_export')
}

function parseJsonOrPackage(text: string, format: 'json' | 'package'): ImportItem[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    throw new Error('unrecognized_export')
  }
  if (format === 'package') {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not_memory_package')
    return parsePackage(parsed as Record<string, unknown>)
  }
  return parseJsonValue(parsed)
}

function parseJsonl(text: string): ImportItem[] {
  let rows: unknown[]
  try {
    rows = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown)
  } catch {
    throw new Error('unrecognized_export')
  }
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
    const made = item({
      category,
      content: line.replace(/^[-*]\s+/, ''),
      source: 'markdown',
      explicit: true,
      note: 'Imported from Markdown. Confirm before saving.',
    })
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
      const made = item({
        category: tagged[1].toLowerCase() as MemoryCategory,
        content: tagged[2],
        source: 'text',
        explicit: true,
        note: 'Imported from text. Confirm before saving.',
      })
      if (made) items.push(made)
    } else {
      const made = item({
        category: 'fact',
        content: line,
        source: 'text',
        explicit: false,
        note: 'Untagged line kept as an unconfirmed fact. Confirm before saving.',
      })
      if (made) items.push(made)
    }
  }
  return items
}

export function parseMemoryImport(format: string, text: string): ImportItem[] {
  resetImportIds()
  const body = text.trim()
  if (!body) return []
  if (format === 'chatgpt' || format === 'gemini' || format === 'deepseek') {
    if (format === 'deepseek' && (body.startsWith('PK') || body.includes('export_format_version'))) {
      throw new Error('deepseek_zip_not_supported')
    }
    throw new Error('adapter_not_implemented')
  }
  if (format === 'json') return parseJsonOrPackage(body, 'json')
  if (format === 'package') return parseJsonOrPackage(body, 'package')
  if (format === 'jsonl') return parseJsonl(body)
  if (format === 'md') return parseMarkdown(body)
  if (format === 'txt') return parseText(body)
  throw new Error('unsupported_format')
}

export function dedupeImports(items: ImportItem[], existing: Array<{ category: string; content: string }>): {
  accepted: ImportItem[]
  duplicates: ImportItem[]
} {
  const seen = new Set(existing.map((row) => `${row.category}\n${row.content.trim().toLowerCase()}`))
  const accepted: ImportItem[] = []
  const duplicates: ImportItem[] = []
  for (const entry of items) {
    const key = `${entry.category}\n${entry.content.trim().toLowerCase()}`
    if (seen.has(key)) duplicates.push(entry)
    else {
      seen.add(key)
      accepted.push(entry)
    }
  }
  return { accepted, duplicates }
}

export function memoryPackage(memories: PortableMemory[]) {
  return {
    kind: MEMORY_PACKAGE_KIND,
    version: MEMORY_PACKAGE_VERSION,
    memories: memories.map((memory) => ({
      category: memory.category,
      content: memory.content,
      source: memory.source,
      explicit: memory.explicit,
      note: memory.note,
      createdAt: memory.createdAt,
      updatedAt: memory.updatedAt,
    })),
  }
}
