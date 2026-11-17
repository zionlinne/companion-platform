import { createHash } from 'node:crypto'
import type { AppConfig } from './config.ts'
import { isUniqueViolation, many, one, run, withTx, type SqlDb } from './db.ts'
import { streamCompletion } from './gateway.ts'
import { newId, nowIso } from './http.ts'
import type { Logger } from './log.ts'
import { locateScore, normalizeText, sameMemory } from './memory-text.ts'
import type { PromptMessage } from './prompt.ts'
import type { MemoryCategory, MemoryRow, MemoryStatus, Space } from './types.ts'

const ATTEMPTS = 3
const MODEL_TIMEOUT_MS = 8000
const STORABLE = new Set<MemoryCategory>([
  'fact', 'event', 'relationship', 'preference', 'habit', 'experience', 'plan',
  'shared_event', 'topic', 'open_item', 'background',
])

export type MemorySource = 'user_requested' | 'user_stated' | 'model_inferred'

export type MemoryDecision = {
  action: 'save' | 'correct' | 'supplement' | 'expire'
  category: MemoryCategory
  content: string
  target: string
  change: 'correction' | 'fact_changed' | 'addition' | null
  confidence: number
  uncertain: boolean
  source: MemorySource
  explicit: boolean
}

export type MemoryScope = {
  userId: string
  space: Space
  characterId: string | null
}

export type ApplyResult = {
  result: 'saved' | 'confirmed' | 'superseded' | 'expired' | 'uncertain' | 'duplicate' | 'persona_locked' | 'skipped'
  memoryId: string | null
  previousId: string | null
}

export type ObserveReport = {
  ok: boolean
  saved: number
  reason: string
  modelReason: string
  provider: 'stub' | 'fixture' | 'live' | 'none'
}

export type MemoryCompleter = (input: { model: string; messages: PromptMessage[]; signal: AbortSignal }) => Promise<string>

let testCompleter: MemoryCompleter | null = null
let tail: Promise<void> = Promise.resolve()

export function setMemoryCompleterForTests(complete: MemoryCompleter | null) {
  testCompleter = complete
}

export function trackObservation(work: Promise<unknown>) {
  tail = tail.then(() => work.then(() => undefined, () => undefined))
}

export function flushObservations() {
  return tail
}

const clip = (value: string, max: number) => value.trim().slice(0, max)

function decisionKey(scope: MemoryScope, messageId: string, decision: MemoryDecision): string {
  return createHash('sha256')
    .update([
      scope.userId,
      scope.space,
      scope.characterId ?? '',
      messageId,
      decision.source,
      decision.action,
      decision.change ?? '',
      normalizeText(decision.content),
      normalizeText(decision.target),
    ].join('\n'))
    .digest('hex')
}

export function parseExplicit(text: string): MemoryDecision | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const correction = /(?:更正|记错了|以前说错了)[:：]\s*([\s\S]+)$/.exec(trimmed)
  if (correction?.[1]) return correctionDecision(correction[1].trim())
  const frames: Array<{ source: MemorySource; category: MemoryCategory; pattern: RegExp }> = [
    { source: 'user_requested', category: 'fact', pattern: /(?:请|帮我)?记住[:：\s]*([\s\S]+)$/ },
    { source: 'user_requested', category: 'fact', pattern: /以后不要忘(?:记)?[:：\s]*([\s\S]+)$/ },
    { source: 'user_requested', category: 'fact', pattern: /不要忘记[:：\s]*([\s\S]+)$/ },
    { source: 'user_requested', category: 'fact', pattern: /记下来[:：\s]*([\s\S]+)$/ },
    { source: 'user_stated', category: 'fact', pattern: /这很重要[:：\s]*([\s\S]+)$/ },
    { source: 'user_stated', category: 'preference', pattern: /长期偏好[:：\s]*([\s\S]+)$/ },
  ]
  for (const frame of frames) {
    const match = frame.pattern.exec(trimmed)
    const content = clip(match?.[1] ?? '', 4000)
    if (content.length < 2) continue
    return {
      action: 'save',
      category: frame.category,
      content,
      target: '',
      change: null,
      confidence: 1,
      uncertain: false,
      source: frame.source,
      explicit: true,
    }
  }
  return null
}

function correctionDecision(body: string): MemoryDecision {
  const base = {
    category: 'fact' as const,
    confidence: 1,
    source: 'user_stated' as const,
    explicit: true,
  }
  const replaced = /^不是(.+?)[，,]\s*(?:而是|是)(.+)$/.exec(body)
  if (replaced?.[1] && replaced[2] && replaced[1].trim().length >= 1 && replaced[2].trim().length >= 1) {
    return {
      ...base,
      action: 'correct',
      content: clip(replaced[2], 4000),
      target: clip(replaced[1], 400),
      change: 'correction',
      uncertain: false,
    }
  }
  const stopped = /^(?:我)?不再(.+?)[，,]\s*(?:改用|现在用|改为)(.+)$/.exec(body)
  if (stopped?.[1] && stopped[2]) {
    return {
      ...base,
      action: 'expire',
      content: clip(`不再${stopped[1].trim()}，改用 ${stopped[2].trim()}`, 4000),
      target: clip(stopped[1], 400),
      change: 'fact_changed',
      uncertain: false,
    }
  }
  return {
    ...base,
    action: 'save',
    content: clip(body, 4000) || '未解析的更正',
    target: '',
    change: null,
    confidence: 0.4,
    uncertain: true,
  }
}

export function parseModelMemoryOutput(raw: string): { decisions: MemoryDecision[] } | { error: 'bad_json' } {
  const trimmed = raw.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed)
  const text = fenced ? fenced[1] : trimmed
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return { error: 'bad_json' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return { error: 'bad_json' }
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { memories?: unknown }).memories)) {
    return { error: 'bad_json' }
  }
  const decisions: MemoryDecision[] = []
  for (const item of (parsed as { memories: unknown[] }).memories) {
    const decision = modelItem(item)
    if (decision) decisions.push(decision)
  }
  return { decisions }
}

function modelItem(item: unknown): MemoryDecision | null {
  if (!item || typeof item !== 'object') return null
  const row = item as Record<string, unknown>
  const action = row.action
  if (action === 'skip' || action === 'persona') return null
  if (action !== 'save' && action !== 'correct' && action !== 'supplement' && action !== 'expire') return null
  const category = typeof row.category === 'string' ? row.category : ''
  if (category === 'persona' || !STORABLE.has(category as MemoryCategory)) return null
  const content = typeof row.content === 'string' ? clip(row.content, 4000) : ''
  if (content.length < 2 && action !== 'expire') return null
  const confidence = typeof row.confidence === 'number' && Number.isFinite(row.confidence) ? Math.min(1, Math.max(0, row.confidence)) : 0.7
  const change = row.change === 'correction' || row.change === 'fact_changed' || row.change === 'addition' ? row.change : null
  return {
    action,
    category: category as MemoryCategory,
    content,
    target: typeof row.target === 'string' ? clip(row.target, 400) : '',
    change,
    confidence,
    uncertain: row.uncertain === true,
    source: 'model_inferred',
    explicit: false,
  }
}

async function activeMemories(db: SqlDb, scope: MemoryScope): Promise<MemoryRow[]> {
  if (scope.space === 'workspace') {
    return many<MemoryRow>(
      db,
      `SELECT * FROM memories WHERE user_id = ? AND space = 'workspace' AND status = 'active' ORDER BY updated_at DESC`,
      scope.userId
    )
  }
  return many<MemoryRow>(
    db,
    `SELECT * FROM memories WHERE user_id = ? AND character_id = ? AND space = 'companion' AND status = 'active' ORDER BY updated_at DESC`,
    scope.userId,
    scope.characterId
  )
}

export async function loadActiveMemories(db: SqlDb, userId: string, space: Space, characterId: string | null): Promise<MemoryRow[]> {
  return activeMemories(db, { userId, space, characterId })
}

function locate(rows: MemoryRow[], hint: string): { match: MemoryRow | null; ambiguous: boolean } {
  const scored = rows
    .map((row) => ({ row, score: locateScore(hint, row.content) }))
    .filter((item) => item.score >= 0.72)
    .sort((a, b) => b.score - a.score)
  if (!scored.length) return { match: null, ambiguous: false }
  const second = scored[1]
  if (second && scored[0].score - second.score < 0.12) return { match: null, ambiguous: true }
  return { match: scored[0].row, ambiguous: false }
}

async function insertMemory(
  db: SqlDb,
  scope: MemoryScope,
  decision: MemoryDecision,
  status: MemoryStatus,
  note: string,
  supersedesId: string | null
): Promise<string> {
  const id = newId()
  const at = nowIso()
  const confirmed = decision.explicit && status === 'active' ? at : null
  await run(
    db,
    `INSERT INTO memories (
      id, user_id, character_id, category, content, source, explicit, note, status,
      created_at, updated_at, last_confirmed_at, confidence, supersedes_id, superseded_by, space
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    id,
    scope.userId,
    scope.characterId,
    decision.category,
    decision.content || note,
    decision.source,
    decision.explicit ? 1 : 0,
    note,
    status,
    at,
    at,
    confirmed,
    decision.confidence,
    supersedesId,
    scope.space
  )
  return id
}

export async function applyMemoryDecision(db: SqlDb, scope: MemoryScope, decision: MemoryDecision, key: string): Promise<ApplyResult> {
  if (decision.category === 'persona') return { result: 'persona_locked', memoryId: null, previousId: null }
  if (!STORABLE.has(decision.category)) return { result: 'skipped', memoryId: null, previousId: null }
  if (scope.space === 'companion' && !scope.characterId) return { result: 'skipped', memoryId: null, previousId: null }
  if (scope.space === 'workspace' && scope.characterId) return { result: 'skipped', memoryId: null, previousId: null }
  if (decision.content.trim().length < 2 && decision.action !== 'expire') return { result: 'skipped', memoryId: null, previousId: null }
  return withTx(db, async () => {
    if (db.kind === 'postgres') await one(db, `SELECT pg_advisory_xact_lock(hashtext(?)::bigint)`, scope.userId)
    const prior = await one<{ memory_id: string }>(db, `SELECT memory_id FROM memory_applies WHERE dedupe_key = ?`, key)
    if (prior) return { result: 'duplicate', memoryId: prior.memory_id, previousId: null }
    const active = await activeMemories(db, scope)
    const similar = active.find((row) => sameMemory(row.content, decision.content))
    const uncertain = decision.uncertain || decision.confidence < 0.6
    let result: ApplyResult
    if (decision.action === 'save' || decision.action === 'supplement' || decision.change === 'addition') {
      if (similar && !uncertain) {
        if (decision.explicit) {
          const at = nowIso()
          await run(
            db,
            `UPDATE memories SET source = ?, explicit = 1, last_confirmed_at = ?, confidence = 1, updated_at = ? WHERE id = ? AND user_id = ? AND status = 'active'`,
            decision.source,
            at,
            at,
            similar.id,
            scope.userId
          )
        }
        result = { result: decision.explicit ? 'confirmed' : 'duplicate', memoryId: similar.id, previousId: null }
      } else if (uncertain) {
        const memoryId = await insertMemory(db, scope, decision, 'uncertain', 'not_a_current_fact', null)
        result = { result: 'uncertain', memoryId, previousId: null }
      } else {
        const memoryId = await insertMemory(db, scope, decision, 'active', '', null)
        result = { result: 'saved', memoryId, previousId: null }
      }
    } else if (similar && decision.content.trim().length >= 2) {
      result = { result: 'duplicate', memoryId: similar.id, previousId: null }
    } else {
      const found = decision.target ? locate(active, decision.target) : { match: null, ambiguous: false }
      const owned = found.match && (found.match.explicit === 1 || found.match.source === 'user_requested' || found.match.source === 'user_stated')
      const blocked = Boolean(owned && decision.source === 'model_inferred' && decision.confidence < 0.75)
      const match = found.match
      const hold = uncertain || found.ambiguous || blocked || !match || (decision.change !== 'correction' && decision.change !== 'fact_changed')
      if (hold || !match) {
        const note = found.ambiguous ? 'ambiguous_target' : blocked ? 'explicit_not_overwritten' : !match ? 'target_not_found' : 'not_a_current_fact'
        const content = decision.content.trim().length >= 2 ? decision.content : decision.target
        if (content.trim().length < 2) {
          result = { result: 'skipped', memoryId: null, previousId: match?.id ?? null }
        } else {
          const memoryId = await insertMemory(db, scope, { ...decision, content }, 'uncertain', note, null)
          result = { result: 'uncertain', memoryId, previousId: match?.id ?? null }
        }
      } else if (sameMemory(match.content, decision.content)) {
        result = { result: 'duplicate', memoryId: match.id, previousId: null }
      } else {
        const nextStatus: MemoryStatus = decision.change === 'fact_changed' || decision.action === 'expire' ? 'expired' : 'superseded'
        const memoryId = await insertMemory(db, scope, decision, 'active', '', match.id)
        const changed = await run(
          db,
          `UPDATE memories SET status = ?, superseded_by = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status = 'active'`,
          nextStatus,
          memoryId,
          nowIso(),
          match.id,
          scope.userId
        )
        if (!changed) throw new Error('memory_conflict')
        result = { result: nextStatus === 'expired' ? 'expired' : 'superseded', memoryId, previousId: match.id }
      }
    }
    await run(
      db,
      `INSERT INTO memory_applies (dedupe_key, user_id, memory_id, created_at) VALUES (?, ?, ?, ?)`,
      key,
      scope.userId,
      result.memoryId ?? 'none',
      nowIso()
    )
    return result
  })
}

const EXTRACTION_PROMPT = [
  'MEMORY_ENGINE',
  '你是记忆整理器。只输出 JSON，不要输出其他文字。',
  '只保留稳定偏好和习惯、重要经历和事实、长期计划和项目、Companion 的重要共同经历、会持续有用的背景。普通寒暄和一次性问答不要保存。',
  '不要修改人格，也不要输出 category 为 persona 的项。不要把推断写成用户明确说过的事实。',
  '更正已有记忆时，target 填写旧记忆里能唯一定位的片段。change 用 correction 表示原来就错，fact_changed 表示过去为真但现在不再当前，addition 表示补充且不覆盖。',
  '目标不唯一或不能确定时，uncertain 设为 true。没有值得保存的内容时返回 {"memories":[]}。',
  'JSON: {"memories":[{"action":"save"|"correct"|"supplement"|"expire"|"skip","category":"preference"|"habit"|"experience"|"plan"|"shared_event"|"topic"|"open_item"|"relationship"|"background"|"fact"|"event","content":"...","target":"","change":"correction"|"fact_changed"|"addition"|null,"confidence":0.0,"uncertain":false}]}',
].join('\n')

function extractionMessages(userText: string, assistantText: string, active: MemoryRow[]): PromptMessage[] {
  const lines = active.slice(0, 20).map((row) => `- ${row.content.slice(0, 160)}`)
  return [
    { role: 'system', content: `${EXTRACTION_PROMPT}\n当前有效记忆：\n${lines.length ? lines.join('\n') : '(none)'}` },
    { role: 'user', content: `用户：${clip(userText, 2000)}\n助手：${clip(assistantText, 2000)}` },
  ]
}

async function claimJob(db: SqlDb, messageId: string, userId: string): Promise<'run' | 'done' | 'gave_up'> {
  const now = nowIso()
  const existing = await one<{ attempts: number; state: string }>(db, `SELECT attempts, state FROM memory_jobs WHERE message_id = ?`, messageId)
  if (!existing) {
    try {
      await run(
        db,
        `INSERT INTO memory_jobs (message_id, user_id, attempts, state, reason, created_at, updated_at) VALUES (?, ?, 1, 'pending', '', ?, ?)`,
        messageId,
        userId,
        now,
        now
      )
      return 'run'
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
    }
  }
  const current = await one<{ attempts: number; state: string }>(db, `SELECT attempts, state FROM memory_jobs WHERE message_id = ?`, messageId)
  if (!current) return 'run'
  if (current.state === 'done') return 'done'
  if (current.attempts >= ATTEMPTS) return 'gave_up'
  await run(db, `UPDATE memory_jobs SET attempts = attempts + 1, state = 'pending', updated_at = ? WHERE message_id = ?`, now, messageId)
  return 'run'
}

async function finishJob(db: SqlDb, messageId: string, state: 'done' | 'failed', reason: string) {
  await run(db, `UPDATE memory_jobs SET state = ?, reason = ?, updated_at = ? WHERE message_id = ?`, state, reason.slice(0, 80), nowIso(), messageId)
}

function providerOf(config: AppConfig, complete: MemoryCompleter | undefined): ObserveReport['provider'] {
  if (complete || (config.nodeEnv === 'test' && testCompleter)) return 'stub'
  return config.gatewayMode === 'live' ? 'live' : 'fixture'
}

function modelFailure(error: unknown): 'timeout' | 'provider_error' {
  if (!error || typeof error !== 'object') return 'provider_error'
  const name = error instanceof Error ? error.name : ''
  const code = 'code' in error ? String((error as { code?: unknown }).code) : ''
  if (name === 'TimeoutError' || name === 'AbortError' || code === 'timeout' || code === 'ABORT_ERR') return 'timeout'
  return 'provider_error'
}

async function completeMemory(input: {
  config: AppConfig
  model: string
  messages: PromptMessage[]
  complete?: MemoryCompleter
  timeoutMs: number
}): Promise<string> {
  const complete = input.complete ?? (input.config.nodeEnv === 'test' ? testCompleter : null) ?? (async (call: { model: string; messages: PromptMessage[]; signal: AbortSignal }) => {
    let content = ''
    await streamCompletion(input.config, {
      model: call.model,
      messages: call.messages,
      thinking: false,
      signal: call.signal,
      onDelta: (delta) => {
        if (delta.content) content += delta.content
      },
    })
    return content
  })
  const signal = AbortSignal.timeout(input.timeoutMs)
  return await new Promise((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error('timeout'), { code: 'timeout' }))
    signal.addEventListener('abort', onAbort, { once: true })
    complete({ model: input.model, messages: input.messages, signal }).then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort)
    })
  })
}

function countable(result: ApplyResult['result']): boolean {
  return result === 'saved' || result === 'confirmed' || result === 'superseded' || result === 'expired' || result === 'uncertain'
}

// Best-effort and in-process. A free-host sleep or restart can drop an extraction that has not finished.
// The chat reply is already saved. The same message is retried up to three times only if this function runs again.
export async function observeChatTurn(input: {
  db: SqlDb
  config: AppConfig
  log: Logger
  userId: string
  space: Space
  characterId: string | null
  messageId: string
  userText: string
  assistantText: string
  model: string
  complete?: MemoryCompleter
  timeoutMs?: number
}): Promise<ObserveReport> {
  const provider = providerOf(input.config, input.complete)
  const report: ObserveReport = { ok: true, saved: 0, reason: 'empty', modelReason: 'skipped', provider }
  const logReport = () => {
    input.log.info('memory_observe', {
      result: report.reason,
      model: report.modelReason,
      saved: report.saved,
      provider: report.provider,
      space: input.space,
    })
  }
  try {
    const claim = await claimJob(input.db, input.messageId, input.userId)
    if (claim === 'done') {
      report.reason = 'duplicate'
      report.modelReason = 'duplicate'
      logReport()
      return report
    }
    if (claim === 'gave_up') {
      report.reason = 'gave_up'
      report.modelReason = 'gave_up'
      logReport()
      return report
    }
    const scope: MemoryScope = { userId: input.userId, space: input.space, characterId: input.characterId }
    const explicit = parseExplicit(input.userText)
    if (explicit) {
      const applied = await applyMemoryDecision(input.db, scope, explicit, decisionKey(scope, input.messageId, explicit))
      if (countable(applied.result)) report.saved += 1
    }
    const active = await activeMemories(input.db, scope)
    let raw = ''
    try {
      raw = await completeMemory({
        config: input.config,
        model: input.model,
        messages: extractionMessages(input.userText, input.assistantText, active),
        complete: input.complete,
        timeoutMs: input.timeoutMs ?? MODEL_TIMEOUT_MS,
      })
    } catch (error) {
      report.modelReason = modelFailure(error)
      await finishJob(input.db, input.messageId, 'failed', report.modelReason)
      report.reason = report.saved ? 'saved' : report.modelReason
      logReport()
      return report
    }
    const parsed = parseModelMemoryOutput(raw)
    if ('error' in parsed) {
      await finishJob(input.db, input.messageId, 'failed', 'bad_json')
      report.modelReason = 'bad_json'
      report.reason = report.saved ? 'saved' : 'bad_json'
      logReport()
      return report
    }
    for (const decision of parsed.decisions) {
      const applied = await applyMemoryDecision(input.db, scope, decision, decisionKey(scope, input.messageId, decision))
      if (countable(applied.result)) report.saved += 1
    }
    await finishJob(input.db, input.messageId, 'done', 'ok')
    report.modelReason = 'ok'
    report.reason = report.saved ? 'saved' : 'empty'
    logReport()
    return report
  } catch {
    try {
      await finishJob(input.db, input.messageId, 'failed', 'write_failed')
    } catch {
      // The database is unavailable. The chat reply is already stored.
    }
    report.ok = false
    report.reason = 'write_failed'
    report.modelReason = 'write_failed'
    logReport()
    return report
  }
}
