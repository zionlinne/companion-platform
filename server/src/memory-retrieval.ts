import type { AppConfig } from './config.ts'
import { one, run, type SqlDb } from './db.ts'
import {
  activeEmbedder,
  contentHash,
  cosine,
  decodeVector,
  encodeVector,
  type Embedder,
} from './embedding.ts'
import type { Logger } from './log.ts'
import { relevance, retrievalScore } from './memory-text.ts'
import { PROMPT_LIMITS, rankMemories, type MemorySnippet } from './prompt.ts'
import type { MemoryRow } from './types.ts'

const CANDIDATE_LIMIT = 200
const BACKFILL_LIMIT = 8
const LEXICAL_MIN = 0.12

export type RetrievalResult = {
  memories: MemorySnippet[]
  mode: 'lexical' | 'hybrid'
  model: string | null
  dimensions: number | null
  version: string | null
  degraded: string | null
}

type StoredVector = {
  memory_id: string
  model: string
  dimensions: number
  version: string
  content_hash: string
  vector_base64: string
}

export async function deleteEmbedding(db: SqlDb, memoryId: string): Promise<void> {
  await run(db, `DELETE FROM memory_embeddings WHERE memory_id = ?`, memoryId)
}

export async function selectPromptMemories(
  db: SqlDb,
  config: AppConfig,
  log: Logger,
  input: { userId: string; space: 'companion' | 'workspace'; characterId: string | null; topic?: string }
): Promise<RetrievalResult> {
  const rows = await candidates(db, input)
  const snippets = rows.map(snippetOf)
  if (!rows.length) return lexical(snippets, input.topic)
  const embedder = input.topic?.trim() ? activeEmbedder(config) : null
  if (!embedder) return lexical(snippets, input.topic)
  try {
    const semantic = await withTimeout(config.embeddingTimeoutMs, (signal) =>
      rankSemantic(db, embedder, rows, input.topic!.trim(), config.embeddingMinCosine, signal)
    )
    const mode = semantic.semantic ? 'hybrid' : 'lexical'
    log.info('memory_retrieval', {
      mode,
      model: embedder.model,
      dimensions: semantic.dimensions,
      candidates: rows.length,
      kept: semantic.memories.length,
      degraded: semantic.degraded,
    })
    return {
      memories: semantic.memories,
      mode,
      model: mode === 'hybrid' ? embedder.model : null,
      dimensions: semantic.dimensions,
      version: mode === 'hybrid' ? embedder.version : null,
      degraded: semantic.degraded,
    }
  } catch (error) {
    const reason = error instanceof Error && 'code' in error && error.code === 'timeout' ? 'timeout' : 'error'
    log.info('memory_retrieval', { mode: 'lexical', degraded: reason, candidates: rows.length })
    return { ...lexical(snippets, input.topic), degraded: reason }
  }
}

function lexical(snippets: MemorySnippet[], topic?: string): RetrievalResult {
  return { memories: rankMemories(snippets, topic), mode: 'lexical', model: null, dimensions: null, version: null, degraded: null }
}

async function rankSemantic(
  db: SqlDb,
  embedder: Embedder,
  rows: MemoryRow[],
  topic: string,
  minimum: number,
  signal: AbortSignal
): Promise<{ memories: MemorySnippet[]; dimensions: number | null; degraded: string | null; semantic: boolean }> {
  let query: Float32Array | null = null
  let degraded: string | null = null
  try {
    query = await embedder.embed(topic, 'query', signal)
  } catch (error) {
    degraded = error instanceof Error && 'code' in error && error.code === 'timeout' ? 'timeout' : 'error'
  }
  if (!query) {
    return { memories: rankMemories(rows.map(snippetOf), topic), dimensions: null, degraded: degraded ?? 'error', semantic: false }
  }
  const vectors = new Map<string, Float32Array>()
  let embedded = 0
  for (const row of rows) {
    if (signal.aborted) {
      degraded = 'timeout'
      break
    }
    const current = await readCurrent(db, embedder, row)
    if (current) {
      vectors.set(row.id, current)
      continue
    }
    if (embedded >= BACKFILL_LIMIT) continue
    try {
      const vector = await writeVector(db, embedder, row, signal)
      embedded += 1
      vectors.set(row.id, vector)
    } catch (error) {
      degraded = error instanceof Error && 'code' in error && error.code === 'timeout' ? 'timeout' : 'error'
      if (degraded === 'timeout') break
    }
  }
  const scored = rows.map((row) => {
    const stored = vectors.get(row.id)
    const semantic = stored && stored.length === query.length ? cosine(query, stored) : null
    const lexicalScore = retrievalScore(topic, row.content)
    const explicit = row.explicit === 1
    const mixed = semantic === null ? lexicalScore : Math.min(1, lexicalScore * 0.35 + semantic * 0.65 + (explicit ? 0.03 : 0))
    const keep = (semantic !== null && semantic >= minimum) || lexicalScore >= LEXICAL_MIN
    return { row, score: mixed, keep, explicit }
  })
  scored.sort((a, b) => b.score - a.score || Number(b.explicit) - Number(a.explicit) || (a.row.updated_at < b.row.updated_at ? 1 : -1))
  const kept = dedupe(scored.filter((item) => item.keep).map((item) => snippetOf(item.row)))
  return { memories: kept, dimensions: query.length, degraded, semantic: vectors.size > 0 }
}

async function readCurrent(db: SqlDb, embedder: Embedder, row: MemoryRow): Promise<Float32Array | null> {
  const stored = await one<StoredVector>(db, `SELECT * FROM memory_embeddings WHERE memory_id = ?`, row.id)
  if (!stored || stored.version !== embedder.version || stored.model !== embedder.model) return null
  if (stored.content_hash !== contentHash(embedder.version, row.content)) return null
  return decodeVector(stored.vector_base64, stored.dimensions)
}

async function writeVector(db: SqlDb, embedder: Embedder, row: MemoryRow, signal: AbortSignal): Promise<Float32Array> {
  const hash = contentHash(embedder.version, row.content)
  const vector = await embedder.embed(row.content, 'passage', signal)
  await run(
    db,
    `INSERT INTO memory_embeddings (memory_id, model, dimensions, version, content_hash, vector_base64, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(memory_id) DO UPDATE SET
       model = excluded.model,
       dimensions = excluded.dimensions,
       version = excluded.version,
       content_hash = excluded.content_hash,
       vector_base64 = excluded.vector_base64,
       updated_at = excluded.updated_at`,
    row.id,
    embedder.model,
    vector.length,
    embedder.version,
    hash,
    encodeVector(vector),
    new Date().toISOString()
  )
  return vector
}

async function candidates(
  db: SqlDb,
  input: { userId: string; space: 'companion' | 'workspace'; characterId: string | null }
): Promise<MemoryRow[]> {
  if (input.space === 'workspace') {
    return db.all<MemoryRow>(
      `SELECT * FROM memories
       WHERE user_id = ? AND space = 'workspace' AND character_id IS NULL AND status = 'active'
       ORDER BY updated_at DESC LIMIT ?`,
      [input.userId, CANDIDATE_LIMIT]
    )
  }
  if (!input.characterId) return []
  return db.all<MemoryRow>(
    `SELECT * FROM memories
     WHERE user_id = ? AND space = 'companion' AND character_id = ? AND status = 'active'
     ORDER BY updated_at DESC LIMIT ?`,
    [input.userId, input.characterId, CANDIDATE_LIMIT]
  )
}

function snippetOf(row: MemoryRow): MemorySnippet {
  return {
    category: row.category,
    content: row.content,
    source: row.source,
    updatedAt: row.updated_at,
    explicit: row.explicit === 1,
    status: row.status,
  }
}

function dedupe(memories: MemorySnippet[]): MemorySnippet[] {
  const kept: MemorySnippet[] = []
  for (const memory of memories) {
    if (kept.some((existing) => existing.content === memory.content || relevance(existing.content, memory.content) >= 0.8)) continue
    kept.push(memory)
    if (kept.length >= PROMPT_LIMITS.memoryCount) break
  }
  return kept
}

function withTimeout<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const signal = AbortSignal.timeout(ms)
  return new Promise((resolve, reject) => {
    const fail = () => reject(Object.assign(new Error('timeout'), { code: 'timeout' }))
    if (signal.aborted) {
      fail()
      return
    }
    signal.addEventListener('abort', fail, { once: true })
    work(signal).then(resolve, reject).finally(() => signal.removeEventListener('abort', fail))
  })
}
