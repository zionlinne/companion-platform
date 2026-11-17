import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import pg, { type PoolClient } from 'pg'

const { Pool, types } = pg
types.setTypeParser(20, (value) => (value === null ? null : Number(value)))
types.setTypeParser(21, (value) => (value === null ? null : Number(value)))
types.setTypeParser(23, (value) => (value === null ? null : Number(value)))

export type SqlKind = 'sqlite' | 'postgres'

export type SqlDb = {
  kind: SqlKind
  exec(sql: string): Promise<void>
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>
  all<T>(sql: string, params?: unknown[]): Promise<T[]>
  run(sql: string, params?: unknown[]): Promise<number>
  transaction<T>(fn: () => Promise<T>): Promise<T>
  close(): Promise<void>
}

const here = path.dirname(fileURLToPath(import.meta.url))
const sqliteTx = new AsyncLocalStorage<true>()
const postgresTx = new AsyncLocalStorage<PoolClient>()

export function toPostgresPlaceholders(sql: string): string {
  let out = ''
  let index = 0
  let n = 0
  while (index < sql.length) {
    const ch = sql[index]
    if (ch === "'") {
      const start = index
      index += 1
      while (index < sql.length) {
        if (sql[index] === "'") {
          if (sql[index + 1] === "'") {
            index += 2
            continue
          }
          index += 1
          break
        }
        index += 1
      }
      out += sql.slice(start, index)
      continue
    }
    if (ch === '?') {
      n += 1
      out += `$${n}`
      index += 1
      continue
    }
    out += ch
    index += 1
  }
  return out
}

export function splitSql(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let index = 0
  while (index < sql.length) {
    const ch = sql[index]
    if (ch === "'") {
      current += ch
      index += 1
      while (index < sql.length) {
        current += sql[index]
        if (sql[index] === "'") {
          if (sql[index + 1] === "'") {
            current += sql[index + 1]
            index += 2
            continue
          }
          index += 1
          break
        }
        index += 1
      }
      continue
    }
    if (ch === ';') {
      if (current.trim()) statements.push(current.trim())
      current = ''
      index += 1
      continue
    }
    current += ch
    index += 1
  }
  if (current.trim()) statements.push(current.trim())
  return statements
}

export function migrationSql(sql: string, kind: SqlKind): string {
  if (kind === 'sqlite') return sql
  return sql
    .split('\n')
    .filter((line) => !/^\s*PRAGMA\b/i.test(line))
    .join('\n')
}

export function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = 'code' in error ? String(error.code) : ''
  if (code === '23505') return true
  const message = error instanceof Error ? error.message : ''
  return message.includes('UNIQUE constraint failed')
}

function publicDbError(error: unknown): Error {
  if (error && typeof error === 'object' && 'status' in error && 'code' in error) return error as unknown as Error
  if (isUniqueViolation(error)) return error instanceof Error ? error : new Error('unique violation')
  const message = error instanceof Error ? error.message : 'database error'
  if (/postgres(?:ql)?:\/\//i.test(message) || /\bpassword\b/i.test(message)) return new Error('Postgres connection failed')
  return error instanceof Error ? error : new Error('database error')
}

export function openDatabase(config: { databaseUrl: string | null; databasePath: string }): SqlDb {
  if (config.databaseUrl) return openPostgres(config.databaseUrl)
  return openSqlite(config.databasePath)
}

function openSqlite(databasePath: string): SqlDb {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true })
  const db = new DatabaseSync(databasePath)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  if (databasePath !== ':memory:') db.exec('PRAGMA journal_mode = WAL')
  let tail = Promise.resolve()
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = tail.then(fn, fn)
    tail = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }
  const get = <T>(sql: string, params: unknown[] = []): T | undefined => db.prepare(sql).get(...params) as T | undefined
  const all = <T>(sql: string, params: unknown[] = []): T[] => db.prepare(sql).all(...params) as T[]
  const run = (sql: string, params: unknown[] = []): number => Number(db.prepare(sql).run(...params).changes ?? 0)
  return {
    kind: 'sqlite',
    async exec(sql) {
      if (sqliteTx.getStore()) {
        db.exec(sql)
        return
      }
      await enqueue(async () => {
        db.exec(sql)
      })
    },
    async get<T>(sql: string, params: unknown[] = []) {
      if (sqliteTx.getStore()) return get<T>(sql, params)
      return enqueue(async () => get<T>(sql, params))
    },
    async all<T>(sql: string, params: unknown[] = []) {
      if (sqliteTx.getStore()) return all<T>(sql, params)
      return enqueue(async () => all<T>(sql, params))
    },
    async run(sql, params = []) {
      if (sqliteTx.getStore()) return run(sql, params)
      return enqueue(async () => run(sql, params))
    },
    transaction(fn) {
      return enqueue(async () => {
        db.exec('BEGIN IMMEDIATE')
        try {
          const result = await sqliteTx.run(true, fn)
          db.exec('COMMIT')
          return result
        } catch (error) {
          try {
            db.exec('ROLLBACK')
          } catch {
            // The failed statement already ended the transaction.
          }
          throw error
        }
      })
    },
    async close() {
      await enqueue(async () => {
        db.close()
      })
    },
  }
}

function openPostgres(databaseUrl: string): SqlDb {
  const pool = new Pool({ connectionString: databaseUrl, max: 10 })
  const query = async (sql: string, params: unknown[] = []) => {
    const client = postgresTx.getStore() ?? pool
    try {
      return await client.query(toPostgresPlaceholders(sql), params)
    } catch (error) {
      if (isUniqueViolation(error)) throw error
      throw publicDbError(error)
    }
  }
  return {
    kind: 'postgres',
    async exec(sql) {
      for (const statement of splitSql(sql)) await query(statement)
    },
    async get<T>(sql: string, params: unknown[] = []) {
      const result = await query(sql, params)
      return result.rows[0] as T | undefined
    },
    async all<T>(sql: string, params: unknown[] = []) {
      const result = await query(sql, params)
      return result.rows as T[]
    },
    async run(sql, params = []) {
      const result = await query(sql, params)
      return result.rowCount ?? 0
    },
    async transaction(fn) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await postgresTx.run(client, fn)
        await client.query('COMMIT')
        return result
      } catch (error) {
        try {
          await client.query('ROLLBACK')
        } catch {
          // Ignore a rollback of an already-aborted transaction.
        }
        if (isUniqueViolation(error)) throw error
        throw publicDbError(error)
      } finally {
        client.release()
      }
    },
    async close() {
      await pool.end()
    },
  }
}

export async function migrate(db: SqlDb, migrationsDir = path.resolve(here, '../migrations')): Promise<string[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`)
  const applied = new Set((await db.all<{ id: string }>('SELECT id FROM schema_migrations')).map((row) => row.id))
  const files = fs.readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort()
  const ran: string[] = []
  for (const file of files) {
    if (applied.has(file)) continue
    const sql = migrationSql(fs.readFileSync(path.join(migrationsDir, file), 'utf8'), db.kind)
    await db.transaction(async () => {
      await db.exec(sql)
      await db.run('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)', [file, new Date().toISOString()])
    })
    ran.push(file)
  }
  return ran
}

export async function withTx<T>(db: SqlDb, fn: () => Promise<T>): Promise<T> {
  return db.transaction(fn)
}

export async function one<T>(db: SqlDb, sql: string, ...params: unknown[]): Promise<T | undefined> {
  return db.get<T>(sql, params)
}

export async function many<T>(db: SqlDb, sql: string, ...params: unknown[]): Promise<T[]> {
  return db.all<T>(sql, params)
}

export async function run(db: SqlDb, sql: string, ...params: unknown[]): Promise<number> {
  return db.run(sql, params)
}
