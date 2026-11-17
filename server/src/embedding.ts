import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import type { AppConfig } from './config.ts'

export const LOCAL_EMBEDDING_MODEL = 'Xenova/bge-small-zh-v1.5'
export const LOCAL_EMBEDDING_DIMENSIONS = 512
export const LOCAL_EMBEDDING_VERSION = 'bge-small-zh-v1.5-q8-query-prefix-v1'
const QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：'
const MAX_DIMENSIONS = 4096

export type EmbeddingKind = 'query' | 'passage'

export type Embedder = {
  model: string
  dimensions: number
  version: string
  embed(text: string, kind: EmbeddingKind, signal: AbortSignal): Promise<Float32Array>
}

export type EmbeddingPlan =
  | { kind: 'off'; reason: 'unconfigured' | 'deepseek_has_no_embeddings' }
  | { kind: 'local' }
  | { kind: 'http'; baseUrl: string; apiKey: string; model: string }

type Extractor = (text: string, options: { pooling: 'mean'; normalize: true }) => Promise<{ data: Float32Array }>

let testEmbedder: Embedder | null = null
let localLoading: Promise<Extractor> | null = null

export function setTestEmbedder(embedder: Embedder | null): void {
  testEmbedder = embedder
}

export function embeddingPlan(config: AppConfig): EmbeddingPlan {
  if (config.embeddingMode === 'off') return { kind: 'off', reason: 'unconfigured' }
  if (config.embeddingMode === 'local') return { kind: 'local' }
  const baseUrl = config.embeddingBaseUrl
  const apiKey = config.embeddingApiKey
  const model = config.embeddingModel
  if (!baseUrl || !apiKey || !model) return { kind: 'off', reason: 'unconfigured' }
  let host = ''
  try {
    host = new URL(baseUrl).host
  } catch {
    return { kind: 'off', reason: 'unconfigured' }
  }
  if (host === 'api.deepseek.com') return { kind: 'off', reason: 'deepseek_has_no_embeddings' }
  return { kind: 'http', baseUrl: baseUrl.replace(/\/$/, ''), apiKey, model }
}

export function activeEmbedder(config: AppConfig): Embedder | null {
  if (config.nodeEnv === 'test' && testEmbedder) return testEmbedder
  const plan = embeddingPlan(config)
  if (plan.kind === 'off') return null
  if (plan.kind === 'local') return localEmbedder()
  return httpEmbedder(plan)
}

export function contentHash(version: string, content: string): string {
  return createHash('sha256').update(`${version}\n${content}`).digest('hex')
}

export function normalizeVector(vector: Float32Array): Float32Array {
  let sum = 0
  for (const value of vector) sum += value * value
  const norm = Math.sqrt(sum)
  const out = new Float32Array(vector.length)
  if (!norm) return out
  for (let index = 0; index < vector.length; index += 1) out[index] = vector[index] / norm
  return out
}

export function cosine(left: Float32Array, right: Float32Array): number {
  const length = Math.min(left.length, right.length)
  let dot = 0
  for (let index = 0; index < length; index += 1) dot += left[index] * right[index]
  return dot
}

export function encodeVector(vector: Float32Array): string {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('base64')
}

export function decodeVector(value: string, dimensions: number): Float32Array | null {
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > MAX_DIMENSIONS) return null
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length !== dimensions * 4) return null
  const aligned = new ArrayBuffer(bytes.length)
  new Uint8Array(aligned).set(bytes)
  return new Float32Array(aligned)
}

function localEmbedder(): Embedder {
  return {
    model: LOCAL_EMBEDDING_MODEL,
    dimensions: LOCAL_EMBEDDING_DIMENSIONS,
    version: LOCAL_EMBEDDING_VERSION,
    async embed(text, kind, signal) {
      if (signal.aborted) throw Object.assign(new Error('timeout'), { code: 'timeout' })
      const extractor = await localExtractor()
      if (signal.aborted) throw Object.assign(new Error('timeout'), { code: 'timeout' })
      const prepared = kind === 'query' ? `${QUERY_PREFIX}${text}` : text
      const output = await extractor(prepared, { pooling: 'mean', normalize: true })
      const vector = normalizeVector(Float32Array.from(output.data))
      if (vector.length !== LOCAL_EMBEDDING_DIMENSIONS) {
        throw Object.assign(new Error('unexpected embedding dimensions'), { code: 'bad_dimensions' })
      }
      return vector
    },
  }
}

async function localExtractor(): Promise<Extractor> {
  if (!localLoading) {
    localLoading = loadLocalExtractor().catch((error) => {
      localLoading = null
      throw error
    })
  }
  return localLoading
}

async function loadLocalExtractor(): Promise<Extractor> {
  // A variable specifier keeps this package's typings out of the compile.
  // They clash with the local node:sqlite declaration.
  const specifier = '@huggingface/transformers'
  const transformers = (await import(specifier)) as {
    env: { cacheDir: string; allowLocalModels: boolean }
    pipeline: (task: 'feature-extraction', model: string, options: { dtype: 'q8' }) => Promise<Extractor>
  }
  transformers.env.cacheDir = process.env.EMBEDDING_CACHE_DIR?.trim() || path.join(os.tmpdir(), 'hf-cache')
  transformers.env.allowLocalModels = false
  const extractor = await transformers.pipeline('feature-extraction', LOCAL_EMBEDDING_MODEL, { dtype: 'q8' })
  return extractor as unknown as Extractor
}

function httpEmbedder(plan: Extract<EmbeddingPlan, { kind: 'http' }>): Embedder {
  return {
    model: plan.model,
    dimensions: 0,
    version: `http:${plan.model}`,
    async embed(text, _kind, signal) {
      let response: Response
      try {
        response = await fetch(`${plan.baseUrl}/embeddings`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${plan.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ model: plan.model, input: text }),
          signal,
        })
      } catch (error) {
        if (signal.aborted) throw Object.assign(new Error('timeout'), { code: 'timeout' })
        throw Object.assign(new Error('embedding provider unreachable'), { code: 'unreachable', name: error instanceof Error ? error.name : 'Error' })
      }
      if (!response.ok) throw Object.assign(new Error('embedding provider rejected the request'), { code: 'provider_error' })
      const body = (await response.json()) as { data?: Array<{ embedding?: number[] }> }
      const raw = body.data?.[0]?.embedding
      if (!raw || raw.length < 1 || raw.length > MAX_DIMENSIONS) {
        throw Object.assign(new Error('embedding response had no vector'), { code: 'bad_dimensions' })
      }
      return normalizeVector(Float32Array.from(raw))
    },
  }
}
