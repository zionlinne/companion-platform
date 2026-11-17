import fs from 'node:fs'
import path from 'node:path'
import type { ServerResponse } from 'node:http'
import { gatewayConfigured } from './config.ts'
import { many, one, run } from './db.ts'
import { GatewayError, streamCompletion } from './gateway.ts'
import { abortBill, closeBill, openBill } from './wallet.ts'
import { HttpError, newId, nowIso, type Ctx } from './http.ts'
import { loadActiveMemories, observeChatTurn, trackObservation } from './memory-engine.ts'
import { selectPromptMemories } from './memory-retrieval.ts'
import {
  assembleCompanionPrompt,
  assembleWorkspacePrompt,
  costMicroUsd,
  type HistoryTurn,
  type MemorySnippet,
  type PersonaCard,
} from './prompt.ts'
import type { AttachmentRow, CharacterRow, ConversationRow, MessageRow, QuotaRow } from './types.ts'

export async function ownConversation(ctx: Ctx, id: string): Promise<ConversationRow> {
  const row = await one<ConversationRow>(
    ctx.db,
    `SELECT * FROM conversations WHERE id = ? AND user_id = ?`,
    id,
    ctx.user!.id
  )
  if (!row) throw new HttpError(404, 'not_found', 'Not found')
  return row
}

export async function messagePath(ctx: Ctx, conversationId: string, leafId: string | null): Promise<MessageRow[]> {
  const rows = await many<MessageRow>(ctx.db, `SELECT * FROM messages WHERE conversation_id = ? AND user_id = ?`, conversationId, ctx.user!.id)
  const byId = new Map(rows.map((row) => [row.id, row]))
  const path: MessageRow[] = []
  const seen = new Set<string>()
  let current = leafId ? byId.get(leafId) : undefined
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    path.push(current)
    current = current.parent_id ? byId.get(current.parent_id) : undefined
  }
  return path.reverse()
}

export async function decorateMessages(ctx: Ctx, conversation: ConversationRow) {
  const rows = await many<MessageRow>(
    ctx.db,
    `SELECT * FROM messages WHERE conversation_id = ? AND user_id = ? ORDER BY created_at, id`,
    conversation.id,
    conversation.user_id
  )
  const active = await messagePath(ctx, conversation.id, conversation.active_message_id)
  return active.map((message) => {
    const siblings = rows
      .filter((row) => row.parent_id === message.parent_id && row.role === message.role)
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
    return {
      id: message.id,
      parentId: message.parent_id,
      role: message.role,
      content: message.content,
      reasoning: message.reasoning,
      status: message.status,
      createdAt: message.created_at,
      updatedAt: message.updated_at,
      siblingIndex: siblings.findIndex((row) => row.id === message.id),
      siblingCount: siblings.length,
      siblingIds: siblings.map((row) => row.id),
    }
  })
}

export async function assertQuota(ctx: Ctx): Promise<void> {
  const quota = await one<QuotaRow>(ctx.db, `SELECT * FROM quotas WHERE user_id = ?`, ctx.user!.id)
  if (!quota) return
  const start = new Date()
  start.setUTCHours(0, 0, 0, 0)
  const usage = await one<{ requests: number; tokens: number }>(
    ctx.db,
    `SELECT count(*) AS requests,
            coalesce(sum(coalesce(prompt_tokens, 0) + coalesce(completion_tokens, 0)), 0) AS tokens
     FROM usage_ledger WHERE user_id = ? AND created_at >= ?`,
    ctx.user!.id,
    start.toISOString()
  )
  if ((usage?.requests ?? 0) >= quota.daily_request_limit) {
    throw new HttpError(429, 'quota_requests', 'Daily request limit reached')
  }
  if ((usage?.tokens ?? 0) >= quota.daily_token_limit) {
    throw new HttpError(429, 'quota_tokens', 'Daily token limit reached')
  }
}

function personaOf(character: CharacterRow): PersonaCard {
  return {
    name: character.name,
    identity: character.identity,
    background: character.background,
    traits: character.traits,
    style: character.style,
    habits: character.habits,
    relationship: character.relationship,
    rules: character.rules,
  }
}

function sendEvent(res: ServerResponse, event: string, data: unknown) {
  if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

export async function streamAssistant(
  ctx: Ctx,
  conversation: ConversationRow,
  input: { parentId: string | null; history: HistoryTurn[]; model: string; thinking: boolean; attachmentExcerpt?: string }
): Promise<void> {
  if (!gatewayConfigured(ctx.config)) {
    throw new HttpError(
      503,
      'model_gateway_unconfigured',
      'Server model provider key is not configured. Chat is unavailable until an administrator sets DEEPSEEK_API_KEY. This server does not invent model replies.'
    )
  }
  let character: CharacterRow | undefined
  if (conversation.space === 'companion') {
    character = await one<CharacterRow>(
      ctx.db,
      `SELECT * FROM characters WHERE id = ? AND user_id = ?`,
      conversation.character_id,
      ctx.user!.id
    )
    if (!character) throw new HttpError(404, 'not_found', 'Not found')
  }
  const assistantId = newId()
  const at = nowIso()
  const userId = ctx.user!.id
  await openBill(ctx.db, ctx.config, userId, assistantId)
  try {
  await run(
    ctx.db,
    `INSERT INTO messages (id, user_id, conversation_id, parent_id, role, content, reasoning, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'assistant', '', NULL, 'streaming', ?, ?)`,
    assistantId,
    ctx.user!.id,
    conversation.id,
    input.parentId,
    at,
    at
  )
  await run(
    ctx.db,
    `UPDATE conversations SET active_message_id = ?, model = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
    assistantId,
    input.model,
    at,
    conversation.id,
    ctx.user!.id
  )
  } catch (error) {
    await abortBill(ctx.db, userId, assistantId)
    throw error
  }
  const topic = [...input.history].reverse().find((turn) => turn.role === 'user')?.content
  let snippets: MemorySnippet[]
  let ranked = false
  try {
    const selected = await selectPromptMemories(ctx.db, ctx.config, ctx.log, {
      userId: ctx.user!.id,
      space: conversation.space,
      characterId: conversation.character_id,
      topic,
    })
    snippets = selected.memories
    ranked = selected.mode === 'hybrid'
  } catch (error) {
    ctx.log.info('memory_retrieval', { degraded: 'error', name: error instanceof Error ? error.name : 'Error' })
    const memories = await loadActiveMemories(ctx.db, ctx.user!.id, conversation.space, conversation.character_id)
    snippets = memories.map((memory) => ({
      category: memory.category,
      content: memory.content,
      source: memory.source,
      updatedAt: memory.updated_at,
      explicit: memory.explicit === 1,
      status: memory.status,
    }))
  }
  const assembled =
    conversation.space === 'companion' && character
      ? assembleCompanionPrompt({
          persona: personaOf(character),
          memories: snippets,
          history: input.history,
          attachmentExcerpt: input.attachmentExcerpt,
          topic,
          ranked,
        })
      : assembleWorkspacePrompt({
          history: input.history,
          attachmentExcerpt: input.attachmentExcerpt,
          memories: snippets,
          topic,
          ranked,
        })

  ctx.res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff',
  })
  sendEvent(ctx.res, 'meta', {
    assistantMessageId: assistantId,
    model: input.model,
    gatewayMode: ctx.config.gatewayMode,
    realProvider: ctx.config.gatewayMode === 'live',
  })
  const abort = new AbortController()
  const onClose = () => abort.abort()
  ctx.req.on('close', onClose)
  let content = ''
  let reasoning = ''
  try {
    const result = await streamCompletion(ctx.config, {
      model: input.model,
      messages: assembled.messages,
      thinking: input.thinking,
      signal: abort.signal,
      onDelta: (delta) => {
        if (delta.content) content += delta.content
        if (delta.reasoning) reasoning += delta.reasoning
        sendEvent(ctx.res, 'delta', { content: delta.content ?? '', reasoning: delta.reasoning ?? '' })
      },
    })
    const cost = costMicroUsd(input.model, result.promptTokens, result.completionTokens, ctx.config.prices, result.source)
    const doneAt = nowIso()
    await run(
      ctx.db,
      `UPDATE messages SET content = ?, reasoning = ?, status = 'complete', updated_at = ? WHERE id = ? AND user_id = ?`,
      content,
      reasoning || null,
      doneAt,
      assistantId,
      ctx.user!.id
    )
    await run(
      ctx.db,
      `INSERT INTO usage_ledger (id, user_id, conversation_id, model, prompt_tokens, completion_tokens, cost_micro_usd, cost_status, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId(),
      ctx.user!.id,
      conversation.id,
      input.model,
      result.promptTokens,
      result.completionTokens,
      cost.cost,
      cost.status,
      result.source,
      doneAt
    )
    try {
      await closeBill(ctx.db, ctx.config, {
        userId,
        requestId: assistantId,
        kind: 'chat',
        model: input.model,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        source: result.source,
      })
    } catch (error) {
      await abortBill(ctx.db, userId, assistantId)
      ctx.log.error('chat_bill_failed', { name: error instanceof Error ? error.name : 'Error' })
    }
    const userTurn = [...input.history].reverse().find((turn) => turn.role === 'user')
    if (userTurn && input.parentId) {
      trackObservation(observeChatTurn({
        db: ctx.db,
        config: ctx.config,
        log: ctx.log,
        userId: ctx.user!.id,
        space: conversation.space,
        characterId: conversation.character_id,
        messageId: input.parentId,
        userText: userTurn.content,
        assistantText: content,
        model: input.model,
      }))
    }
    sendEvent(ctx.res, 'done', {
      messageId: assistantId,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      costMicroUsd: cost.cost,
      costStatus: cost.status,
      costNote:
        cost.status === 'calculated'
          ? 'Calculated from configured unit price and reported usage. This is not a provider invoice.'
          : cost.status === 'fixture'
            ? 'Fixture protocol usage. This is not a DeepSeek reply and not a provider bill.'
            : 'Usage was reported without a configured unit price. Cost is unknown.',
    })
  } catch (error) {
    await abortBill(ctx.db, userId, assistantId)
    const aborted = abort.signal.aborted
    const code = aborted ? 'aborted' : error instanceof GatewayError ? error.code : 'provider_error'
    const message = aborted
      ? 'Generation stopped.'
      : error instanceof GatewayError
        ? error.message
        : 'Model provider failed. No fallback reply was generated.'
    await run(
      ctx.db,
      `UPDATE messages SET content = ?, reasoning = ?, status = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
      content,
      reasoning || null,
      aborted ? 'aborted' : 'error',
      nowIso(),
      assistantId,
      ctx.user!.id
    )
    ctx.log.error('chat_stream_failed', { code, conversationId: conversation.id })
    sendEvent(ctx.res, 'error', { code, message })
  } finally {
    ctx.req.off('close', onClose)
    if (!ctx.res.writableEnded) ctx.res.end()
  }
}

export function attachmentExcerpt(ctx: Ctx, rows: AttachmentRow[]): string | undefined {
  const parts: string[] = []
  for (const row of rows) {
    const textual = row.media_type.startsWith('text/') || /\.(txt|md|json|jsonl|csv)$/i.test(row.filename)
    if (!textual) {
      parts.push(`[File ${row.filename} is stored but not inlined]`)
      continue
    }
    const full = blobPath(ctx, row.storage_name)
    const bytes = fs.readFileSync(full)
    const text = bytes.subarray(0, 32_768).toString('utf8')
    parts.push(`[${row.filename}]\n${text}`)
  }
  if (!parts.length) return undefined
  return parts.join('\n\n').slice(0, 8000)
}

export function blobPath(ctx: Ctx, storageName: string): string {
  const root = path.resolve(ctx.config.dataDir, 'blobs')
  const full = path.resolve(root, storageName)
  if (full !== root && !full.startsWith(root + path.sep)) throw new HttpError(400, 'bad_path', 'Bad path')
  return full
}
