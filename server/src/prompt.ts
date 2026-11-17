import { relevance, retrievalScore } from './memory-text.ts'

export const PROMPT_LIMITS = {
  personaChars: 4000,
  memoryCount: 12,
  memoryChars: 500,
  historyMessages: 24,
  messageChars: 6000,
}

export type PromptMessage = { role: 'system' | 'user' | 'assistant'; content: string }

export type PersonaCard = {
  name: string
  identity: string
  background: string
  traits: string
  style: string
  habits: string
  relationship: string
  rules: string
}

export type MemorySnippet = {
  category: string
  content: string
  source: string
  updatedAt: string
  explicit: boolean
  status?: string
}

export type HistoryTurn = { role: 'user' | 'assistant'; content: string }

const clip = (value: string, max: number) => (value.length <= max ? value : `${value.slice(0, max)}…`)

export function rankMemories(memories: MemorySnippet[], topic?: string): MemorySnippet[] {
  const current = memories.filter((memory) => (memory.status ?? 'active') === 'active')
  const byTime = [...current].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  if (!topic?.trim()) return byTime.slice(0, PROMPT_LIMITS.memoryCount)
  const ranked = byTime
    .map((memory) => ({ memory, score: retrievalScore(topic, memory.content) }))
    .filter((item) => item.score >= 0.12)
    .sort((a, b) => b.score - a.score || (a.memory.updatedAt < b.memory.updatedAt ? 1 : -1))
  const kept: MemorySnippet[] = []
  for (const item of ranked) {
    if (kept.some((existing) => sameEnough(existing.content, item.memory.content))) continue
    kept.push(item.memory)
    if (kept.length >= PROMPT_LIMITS.memoryCount) break
  }
  return kept
}

function sameEnough(left: string, right: string): boolean {
  return left === right || relevance(left, right) >= 0.8
}

export function personaText(card: PersonaCard): { text: string; truncated: boolean } {
  const lines = [
    `name: ${card.name}`,
    `identity: ${card.identity}`,
    `background: ${card.background}`,
    `traits: ${card.traits}`,
    `style: ${card.style}`,
    `habits: ${card.habits}`,
    `relationship: ${card.relationship}`,
    `rules: ${card.rules}`,
  ]
  const full = lines.join('\n')
  const text = clip(full, PROMPT_LIMITS.personaChars)
  return { text, truncated: text !== full }
}

export function assembleCompanionPrompt(input: {
  persona: PersonaCard
  memories: MemorySnippet[]
  history: HistoryTurn[]
  attachmentExcerpt?: string
  topic?: string
  ranked?: boolean
}): { messages: PromptMessage[]; stats: Record<string, number | boolean> } {
  const persona = personaText(input.persona)
  const kept = input.ranked ? input.memories.slice(0, PROMPT_LIMITS.memoryCount) : rankMemories(input.memories, input.topic)
  const memoryLines = kept.map((memory) => {
    const fact = memory.explicit ? 'explicit' : 'unconfirmed'
    return `- (${memory.category}, ${fact}, source=${memory.source}, updated=${memory.updatedAt}) ${clip(memory.content, PROMPT_LIMITS.memoryChars)}`
  })
  const system = [
    'You are a companion inside Deep Companion.',
    'The persona card is a stable style and identity. It is not long-term memory.',
    'Confirmed memories are a separate bounded list. Do not invent shared history or past events that are not written here.',
    'Uncertain, superseded, and expired memories are not current facts.',
    'Do not claim to have read the user Workspace, private files, or unauthorized timeline events.',
    '[Persona]',
    persona.text,
    '[Memories]',
    memoryLines.length ? memoryLines.join('\n') : '(none)',
  ].join('\n')
  const history = input.history.slice(-PROMPT_LIMITS.historyMessages).map((turn) => ({
    role: turn.role,
    content: clip(turn.content, PROMPT_LIMITS.messageChars),
  }))
  if (input.attachmentExcerpt && history.length) {
    const last = history[history.length - 1]
    if (last.role === 'user') {
      last.content = clip(`${last.content}\n\n[Attachment excerpt]\n${input.attachmentExcerpt}`, PROMPT_LIMITS.messageChars)
    }
  }
  return {
    messages: [{ role: 'system', content: system }, ...history],
    stats: {
      memoriesIncluded: kept.length,
      memoriesOmitted: Math.max(0, input.memories.length - kept.length),
      historyIncluded: history.length,
      historyOmitted: Math.max(0, input.history.length - history.length),
      personaTruncated: persona.truncated,
    },
  }
}

export function assembleWorkspacePrompt(input: {
  history: HistoryTurn[]
  attachmentExcerpt?: string
  memories?: MemorySnippet[]
  topic?: string
  ranked?: boolean
}): { messages: PromptMessage[]; stats: Record<string, number> } {
  const kept = input.memories ? (input.ranked ? input.memories.slice(0, PROMPT_LIMITS.memoryCount) : rankMemories(input.memories, input.topic)) : []
  const memoryLines = kept.map((memory) => {
    const fact = memory.explicit ? 'explicit' : 'unconfirmed'
    return `- (${memory.category}, ${fact}, source=${memory.source}, updated=${memory.updatedAt}) ${clip(memory.content, PROMPT_LIMITS.memoryChars)}`
  })
  const system = [
    'You are assisting inside the user Workspace of Deep Companion.',
    'You cannot see Companion memories, Companion chats, or other users.',
    'Do not invent workspace records or companion history that are not written here.',
    ...(input.memories
      ? ['[Workspace memories]', memoryLines.length ? memoryLines.join('\n') : '(none)']
      : []),
  ].join('\n')
  const history = input.history.slice(-PROMPT_LIMITS.historyMessages).map((turn) => ({
    role: turn.role,
    content: clip(turn.content, PROMPT_LIMITS.messageChars),
  }))
  if (input.attachmentExcerpt && history.length) {
    const last = history[history.length - 1]
    if (last.role === 'user') {
      last.content = clip(`${last.content}\n\n[Attachment excerpt]\n${input.attachmentExcerpt}`, PROMPT_LIMITS.messageChars)
    }
  }
  return {
    messages: [{ role: 'system', content: system }, ...history],
    stats: {
      historyIncluded: history.length,
      historyOmitted: Math.max(0, input.history.length - history.length),
      memoriesIncluded: kept.length,
      memoriesOmitted: Math.max(0, (input.memories?.length ?? 0) - kept.length),
    },
  }
}

export function assembleInitiativePrompt(input: {
  persona: PersonaCard
  granted: Record<string, string>
}): { messages: PromptMessage[] } {
  const persona = personaText(input.persona)
  const fields = Object.entries(input.granted)
    .map(([key, value]) => `${key}: ${clip(value, 1000)}`)
    .join('\n')
  return {
    messages: [
      {
        role: 'system',
        content: [
          'Write one short proactive message in the character voice.',
          'Use only the authorized timeline fields below. Do not invent other workspace facts.',
          'Persona is style, not a memory dump.',
          '[Persona]',
          persona.text,
          '[Authorized timeline fields]',
          fields || '(none)',
        ].join('\n'),
      },
      {
        role: 'user',
        content: 'Create one in-app proactive message from the authorized fields. Keep it under 80 words.',
      },
    ],
  }
}

export function costMicroUsd(
  model: string,
  promptTokens: number | null,
  completionTokens: number | null,
  prices: Record<string, { input_per_million: number; output_per_million: number }>,
  source: 'live' | 'fixture'
): { cost: number | null; status: 'calculated' | 'unknown' | 'fixture' } {
  if (source === 'fixture') return { cost: null, status: 'fixture' }
  if (promptTokens === null || completionTokens === null) return { cost: null, status: 'unknown' }
  const price = prices[model]
  if (!price) return { cost: null, status: 'unknown' }
  const usd =
    (promptTokens / 1_000_000) * price.input_per_million +
    (completionTokens / 1_000_000) * price.output_per_million
  return { cost: Math.round(usd * 1_000_000), status: 'calculated' }
}
