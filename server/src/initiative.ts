import type { AppConfig } from './config.ts'
import { gatewayConfigured } from './config.ts'
import { many, one, run, withTx, type SqlDb } from './db.ts'
import { streamCompletion } from './gateway.ts'
import { newId, nowIso } from './http.ts'
import type { Logger } from './log.ts'
import { assembleInitiativePrompt, costMicroUsd, type PersonaCard } from './prompt.ts'
import type { GrantRow, InitiativeSettingsRow } from './types.ts'

export function inQuietHours(now: Date, start: number | null, end: number | null): boolean {
  if (start === null || end === null || start === end) return false
  const minute = now.getUTCHours() * 60 + now.getUTCMinutes()
  if (start < end) return minute >= start && minute < end
  return minute >= start || minute < end
}

type Candidate = GrantRow & {
  title: string
  summary: string
  occurred_at: string
  due_at: string | null
  name: string
  identity: string
  background: string
  traits: string
  style: string
  habits: string
  relationship: string
  rules: string
}

const grantedFields = (row: Candidate) => {
  const fields: Record<string, string> = {}
  if (row.allow_title) fields.title = row.title
  if (row.allow_summary) fields.summary = row.summary
  if (row.allow_occurred_at) fields.occurredAt = row.occurred_at
  if (row.allow_due_at && row.due_at) fields.dueAt = row.due_at
  return fields
}

export async function tickInitiative(
  deps: { db: SqlDb; config: AppConfig; log: Logger },
  userId: string,
  now = new Date()
) {
  const { db, config, log } = deps
  const settings = await one<InitiativeSettingsRow>(db, `SELECT * FROM initiative_settings WHERE user_id = ?`, userId)
  if (!settings || settings.enabled !== 1) return { status: 'skipped', reason: 'disabled' }
  if (settings.trigger_authorized_timeline !== 1) return { status: 'skipped', reason: 'trigger_disabled' }
  if (inQuietHours(now, settings.quiet_start_minute, settings.quiet_end_minute)) {
    return { status: 'skipped', reason: 'quiet_hours' }
  }
  if (!gatewayConfigured(config)) {
    return { status: 'skipped', reason: 'model_gateway_unconfigured' }
  }
  const dayStart = new Date(now)
  dayStart.setUTCHours(0, 0, 0, 0)
  const used = await one<{ count: number }>(
    db,
    `SELECT count(*) AS count FROM initiative_runs
     WHERE user_id = ? AND created_at >= ? AND status IN ('started', 'sent', 'error')`,
    userId,
    dayStart.toISOString()
  )
  if ((used?.count ?? 0) >= settings.daily_limit) return { status: 'skipped', reason: 'daily_limit' }
  const cap = Math.min(Math.max(settings.max_model_calls_per_tick, 1), 3)
  const candidates = await many<Candidate>(
    db,
    `SELECT g.*, e.title, e.summary, e.occurred_at, e.due_at,
            c.name, c.identity, c.background, c.traits, c.style, c.habits, c.relationship, c.rules
     FROM timeline_grants g
     JOIN timeline_events e ON e.id = g.event_id AND e.user_id = g.user_id
     JOIN characters c ON c.id = g.character_id AND c.user_id = g.user_id AND c.initiative_enabled = 1
     WHERE g.user_id = ? AND g.revoked_at IS NULL
     ORDER BY e.occurred_at ASC`,
    userId
  )
  const results: Array<{ status: string; eventId?: string; messageId?: string; reason?: string }> = []
  let calls = 0
  for (const candidate of candidates) {
    if (calls >= cap) break
    const key = `timeline:${candidate.event_id}:${candidate.character_id}`
    const existing = await one<{ id: string }>(db, `SELECT id FROM initiative_runs WHERE idempotency_key = ?`, key)
    if (existing) continue
    const fields = grantedFields(candidate)
    if (!Object.keys(fields).length) continue
    const runId = newId()
    const at = nowIso()
    try {
      await withTx(db, async () => {
        const again = await one<{ id: string }>(db, `SELECT id FROM initiative_runs WHERE idempotency_key = ?`, key)
        if (again) throw new Error('duplicate')
        await run(
          db,
          `INSERT INTO initiative_runs (id, user_id, idempotency_key, trigger_type, event_id, character_id, status, conversation_id, message_id, created_at)
           VALUES (?, ?, ?, 'authorized_timeline', ?, ?, 'started', NULL, NULL, ?)`,
          runId,
          userId,
          key,
          candidate.event_id,
          candidate.character_id,
          at
        )
      })
    } catch {
      continue
    }
    calls += 1
    await run(
      db,
      `INSERT INTO access_audits (id, user_id, actor, grant_id, event_id, character_id, fields_json, created_at)
       VALUES (?, ?, 'initiative', ?, ?, ?, ?, ?)`,
      newId(),
      userId,
      candidate.id,
      candidate.event_id,
      candidate.character_id,
      JSON.stringify(Object.keys(fields)),
      at
    )
    const persona: PersonaCard = {
      name: candidate.name,
      identity: candidate.identity,
      background: candidate.background,
      traits: candidate.traits,
      style: candidate.style,
      habits: candidate.habits,
      relationship: candidate.relationship,
      rules: candidate.rules,
    }
    const prompt = assembleInitiativePrompt({ persona, granted: fields })
    let content = ''
    try {
      const result = await streamCompletion(config, {
        model: 'deepseek-flash',
        messages: prompt.messages,
        thinking: false,
        onDelta: (delta) => {
          if (delta.content) content += delta.content
        },
      })
      const conversationId = newId()
      const userMessageId = newId()
      const assistantId = newId()
      const fieldText = Object.entries(fields)
        .map(([name, value]) => `${name}: ${value}`)
        .join('\n')
      const cost = costMicroUsd('deepseek-flash', result.promptTokens, result.completionTokens, config.prices, result.source)
      const doneAt = nowIso()
      await withTx(db, async () => {
        await run(
          db,
          `INSERT INTO conversations (id, user_id, space, character_id, title, model, active_message_id, created_at, updated_at)
           VALUES (?, ?, 'companion', ?, '主动消息', 'deepseek-flash', ?, ?, ?)`,
          conversationId,
          userId,
          candidate.character_id,
          assistantId,
          doneAt,
          doneAt
        )
        await run(
          db,
          `INSERT INTO messages (id, user_id, conversation_id, parent_id, role, content, reasoning, status, created_at, updated_at)
           VALUES (?, ?, ?, NULL, 'user', ?, NULL, 'complete', ?, ?)`,
          userMessageId,
          userId,
          conversationId,
          `已授权时间线字段:\n${fieldText}`,
          doneAt,
          doneAt
        )
        await run(
          db,
          `INSERT INTO messages (id, user_id, conversation_id, parent_id, role, content, reasoning, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'assistant', ?, NULL, 'complete', ?, ?)`,
          assistantId,
          userId,
          conversationId,
          userMessageId,
          content,
          doneAt,
          doneAt
        )
        await run(
          db,
          `INSERT INTO notifications (id, user_id, kind, title, body, conversation_id, read_at, created_at)
           VALUES (?, ?, 'initiative', '主动消息', ?, ?, NULL, ?)`,
          newId(),
          userId,
          content.slice(0, 240),
          conversationId,
          doneAt
        )
        await run(
          db,
          `INSERT INTO usage_ledger (id, user_id, conversation_id, model, prompt_tokens, completion_tokens, cost_micro_usd, cost_status, source, created_at)
           VALUES (?, ?, ?, 'deepseek-flash', ?, ?, ?, ?, ?, ?)`,
          newId(),
          userId,
          conversationId,
          result.promptTokens,
          result.completionTokens,
          cost.cost,
          cost.status,
          result.source,
          doneAt
        )
        await run(
          db,
          `UPDATE initiative_runs SET status = 'sent', conversation_id = ?, message_id = ? WHERE id = ?`,
          conversationId,
          assistantId,
          runId
        )
      })
      results.push({ status: 'sent', eventId: candidate.event_id, messageId: assistantId })
    } catch (error) {
      await run(db, `UPDATE initiative_runs SET status = 'error' WHERE id = ?`, runId)
      log.error('initiative_failed', { code: error instanceof Error ? error.name : 'error' })
      results.push({ status: 'error', eventId: candidate.event_id, reason: 'provider_error' })
    }
  }
  if (!results.length) return { status: 'skipped', reason: 'nothing_to_send' }
  return { status: 'ok', calls, results }
}

export async function defaultInitiative(db: SqlDb, userId: string) {
  const existing = await one<InitiativeSettingsRow>(db, `SELECT * FROM initiative_settings WHERE user_id = ?`, userId)
  if (existing) return existing
  const at = nowIso()
  await run(
    db,
    `INSERT INTO initiative_settings (user_id, enabled, quiet_start_minute, quiet_end_minute, daily_limit, max_model_calls_per_tick, trigger_authorized_timeline, updated_at)
     VALUES (?, 0, NULL, NULL, 3, 1, 1, ?)`,
    userId,
    at
  )
  const created = await one<InitiativeSettingsRow>(db, `SELECT * FROM initiative_settings WHERE user_id = ?`, userId)
  if (!created) throw new Error('initiative settings were not saved')
  return created
}

export function publicSettings(row: InitiativeSettingsRow) {
  return {
    enabled: row.enabled === 1,
    quietStartMinute: row.quiet_start_minute,
    quietEndMinute: row.quiet_end_minute,
    dailyLimit: row.daily_limit,
    maxModelCallsPerTick: row.max_model_calls_per_tick,
    triggers: {
      authorized_timeline: { enabled: row.trigger_authorized_timeline === 1, implemented: true },
      schedule: { enabled: false, implemented: false },
      work_event: { enabled: false, implemented: false },
      history_followup: { enabled: false, implemented: false },
      date_reminder: { enabled: false, implemented: false },
    },
  }
}
