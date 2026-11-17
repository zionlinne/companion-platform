import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

export type SqlRow = Record<string, unknown>

const here = path.dirname(fileURLToPath(import.meta.url))

export function openDatabase(databasePath: string): DatabaseSync {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true })
  const db = new DatabaseSync(databasePath)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  if (databasePath !== ':memory:') db.exec('PRAGMA journal_mode = WAL')
  return db
}

export function migrate(db: DatabaseSync, migrationsDir = path.resolve(here, '../migrations')): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`)
  const applied = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as Array<{ id: string }>).map((row) => row.id)
  )
  const files = fs.readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort()
  const ran: string[] = []
  for (const file of files) {
    if (applied.has(file)) continue
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8')
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(sql)
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(file, new Date().toISOString())
      db.exec('COMMIT')
      ran.push(file)
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // The failed statement already ended the transaction.
      }
      throw error
    }
  }
  return ran
}

export function withTx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // Ignore a rollback of an already-aborted transaction.
    }
    throw error
  }
}

export function one<T>(db: DatabaseSync, sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined
}

export function many<T>(db: DatabaseSync, sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...params) as T[]
}

export function run(db: DatabaseSync, sql: string, ...params: unknown[]): number {
  const result = db.prepare(sql).run(...params)
  return Number(result.changes ?? 0)
}
