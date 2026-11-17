import { randomBytes } from 'node:crypto'
import type { AppConfig } from './config.ts'
import { isUniqueViolation, many, one, run, withTx, type SqlDb } from './db.ts'
import { HttpError, newId, nowIso, sha256 } from './http.ts'
import type { Logger } from './log.ts'
import { assertPasswordPolicy, hashPassword, verifyPassword } from './password.ts'
import type { InvitationRow, SessionRow, UserRow } from './types.ts'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

let dummyHashPromise: Promise<string> | null = null
const dummyHash = () => {
  dummyHashPromise ??= hashPassword('not-a-real-user-password')
  return dummyHashPromise
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function normalizeInvite(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
}

export function hashInvite(code: string): string {
  return sha256(normalizeInvite(code))
}

function formatCode(raw: string): string {
  return raw.match(/.{1,4}/g)?.join('-') ?? raw
}

function randomCode(): string {
  const bytes = randomBytes(16)
  let out = ''
  for (let i = 0; i < 12; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length]
  return formatCode(out)
}

export async function insertQuota(db: SqlDb, userId: string, config: AppConfig, at: string): Promise<void> {
  await run(
    db,
    `INSERT INTO quotas (user_id, daily_request_limit, daily_token_limit, updated_at) VALUES (?, ?, ?, ?)`,
    userId,
    config.defaultDailyRequests,
    config.defaultDailyTokens,
    at
  )
}

async function insertAdminIfMissing(db: SqlDb, config: AppConfig, user: UserRow, at: string): Promise<'created' | 'exists' | 'email_taken'> {
  return withTx(db, async () => {
    if (db.kind === 'postgres') await db.get('SELECT pg_advisory_xact_lock(814398)')
    const existing = await one<{ id: string }>(db, `SELECT id FROM users WHERE role = 'admin' AND deleted_at IS NULL`)
    if (existing) return 'exists'
    try {
      await run(
        db,
        `INSERT INTO users (id, email, password_hash, display_name, role, created_at, updated_at, last_seen_at, deleted_at)
         VALUES (?, ?, ?, ?, 'admin', ?, ?, NULL, NULL)`,
        user.id,
        user.email,
        user.password_hash,
        user.display_name,
        at,
        at
      )
    } catch (error) {
      if (isUniqueViolation(error)) return 'email_taken'
      throw error
    }
    await insertQuota(db, user.id, config, at)
    return 'created'
  })
}

export async function initAdmin(db: SqlDb, config: AppConfig, email: string, password: string): Promise<UserRow> {
  const normalized = normalizeEmail(email)
  if (!EMAIL.test(normalized)) throw new HttpError(400, 'invalid_email', 'Invalid email')
  try {
    assertPasswordPolicy(password)
  } catch {
    throw new HttpError(400, 'password_policy', 'Password must be 12-200 characters')
  }
  const at = nowIso()
  const user: UserRow = {
    id: newId(),
    email: normalized,
    password_hash: await hashPassword(password),
    display_name: 'Administrator',
    role: 'admin',
    created_at: at,
    updated_at: at,
    last_seen_at: null,
    deleted_at: null,
  }
  const outcome = await insertAdminIfMissing(db, config, user, at)
  if (outcome === 'exists') throw new HttpError(409, 'admin_exists', 'An administrator already exists')
  if (outcome === 'email_taken') throw new HttpError(409, 'email_taken', 'Email is already registered')
  return user
}

export async function bootstrapAdmin(
  db: SqlDb,
  config: AppConfig,
  email: string | undefined,
  password: string | undefined,
  log: Logger
): Promise<'skipped' | 'created' | 'exists' | 'rejected'> {
  const trimmedEmail = email?.trim() ?? ''
  const suppliedPassword = password ?? ''
  if (!trimmedEmail && !suppliedPassword) {
    log.info('admin_bootstrap', { result: 'skipped' })
    return 'skipped'
  }
  if (!trimmedEmail || !suppliedPassword || !EMAIL.test(normalizeEmail(trimmedEmail))) {
    log.error('admin_bootstrap', { result: 'rejected', reason: 'invalid_env' })
    return 'rejected'
  }
  try {
    assertPasswordPolicy(suppliedPassword)
  } catch {
    log.error('admin_bootstrap', { result: 'rejected', reason: 'password_policy' })
    return 'rejected'
  }
  const at = nowIso()
  const user: UserRow = {
    id: newId(),
    email: normalizeEmail(trimmedEmail),
    password_hash: await hashPassword(suppliedPassword),
    display_name: 'Administrator',
    role: 'admin',
    created_at: at,
    updated_at: at,
    last_seen_at: null,
    deleted_at: null,
  }
  const outcome = await insertAdminIfMissing(db, config, user, at)
  if (outcome === 'email_taken') {
    log.error('admin_bootstrap', { result: 'rejected', reason: 'email_taken' })
    return 'rejected'
  }
  log.info('admin_bootstrap', { result: outcome })
  return outcome
}

export async function createInvitations(
  db: SqlDb,
  adminId: string,
  count: number,
  maxUses = 1,
  note: string | null = null
): Promise<Array<{ id: string; code: string; maxUses: number; expiresAt: null }>> {
  if (!Number.isInteger(count) || count < 1 || count > 50) {
    throw new HttpError(400, 'invalid_count', 'Invitation count must be 1-50')
  }
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 20) {
    throw new HttpError(400, 'invalid_field', 'maxUses must be 1-20')
  }
  const created: Array<{ id: string; code: string; maxUses: number; expiresAt: null }> = []
  const at = nowIso()
  await withTx(db, async () => {
    for (let i = 0; i < count; i += 1) {
      const code = randomCode()
      const id = newId()
      await run(
        db,
        `INSERT INTO invitations (id, code_hash, created_by, max_uses, use_count, expires_at, revoked_at, created_at, note)
         VALUES (?, ?, ?, ?, 0, NULL, NULL, ?, ?)`,
        id,
        hashInvite(code),
        adminId,
        maxUses,
        at,
        note
      )
      created.push({ id, code, maxUses, expiresAt: null })
    }
  })
  return created
}

export async function registerUser(
  db: SqlDb,
  config: AppConfig,
  input: { email: string; password: string; invitationCode: string; displayName?: string }
): Promise<UserRow> {
  const email = normalizeEmail(input.email)
  if (!EMAIL.test(email)) throw new HttpError(400, 'invalid_email', 'Invalid email')
  try {
    assertPasswordPolicy(input.password)
  } catch {
    throw new HttpError(400, 'password_policy', 'Password must be 12-200 characters')
  }
  const displayName = (input.displayName ?? email.split('@')[0] ?? 'User').trim().slice(0, 80) || 'User'
  const passwordHash = await hashPassword(input.password)
  const codeHash = hashInvite(input.invitationCode || '')
  const at = nowIso()
  return await withTx(db, async () => {
    const invite = await one<InvitationRow>(db, `SELECT * FROM invitations WHERE code_hash = ?`, codeHash)
    if (!invite || invite.revoked_at || invite.use_count >= invite.max_uses) {
      throw new HttpError(400, 'invitation_invalid', 'Invitation code is invalid')
    }
    if (invite.expires_at && invite.expires_at < at) {
      throw new HttpError(400, 'invitation_invalid', 'Invitation code is invalid')
    }
    const existing = await one<{ id: string }>(db, `SELECT id FROM users WHERE email = ?`, email)
    if (existing) throw new HttpError(409, 'email_taken', 'Email is already registered')
    const changed = await run(
      db,
      `UPDATE invitations SET use_count = use_count + 1 WHERE id = ? AND use_count < max_uses AND revoked_at IS NULL`,
      invite.id
    )
    if (changed !== 1) throw new HttpError(400, 'invitation_invalid', 'Invitation code is invalid')
    const user: UserRow = {
      id: newId(),
      email,
      password_hash: passwordHash,
      display_name: displayName,
      role: 'user',
      created_at: at,
      updated_at: at,
      last_seen_at: at,
      deleted_at: null,
    }
    try {
      await run(
        db,
        `INSERT INTO users (id, email, password_hash, display_name, role, created_at, updated_at, last_seen_at, deleted_at)
         VALUES (?, ?, ?, ?, 'user', ?, ?, ?, NULL)`,
        user.id,
        user.email,
        user.password_hash,
        user.display_name,
        at,
        at,
        at
      )
    } catch (error) {
      if (isUniqueViolation(error)) throw new HttpError(409, 'email_taken', 'Email is already registered')
      throw error
    }
    await run(
      db,
      `INSERT INTO invitation_redemptions (id, invitation_id, user_id, created_at) VALUES (?, ?, ?, ?)`,
      newId(),
      invite.id,
      user.id,
      at
    )
    await insertQuota(db, user.id, config, at)
    return user
  })
}

export async function authenticate(db: SqlDb, email: string, password: string): Promise<UserRow | null> {
  const user = await one<UserRow>(db, `SELECT * FROM users WHERE email = ? AND deleted_at IS NULL`, normalizeEmail(email))
  const hash = user?.password_hash ?? (await dummyHash())
  const ok = await verifyPassword(password, hash)
  if (!user || !ok) return null
  return user
}

export async function createSession(db: SqlDb, config: AppConfig, userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  const at = nowIso()
  const expires = new Date(Date.now() + config.sessionTtlHours * 3600 * 1000).toISOString()
  await run(
    db,
    `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)`,
    newId(),
    userId,
    sha256(token),
    at,
    expires
  )
  await run(db, `UPDATE users SET last_seen_at = ?, updated_at = ? WHERE id = ?`, at, at, userId)
  return token
}

export async function userFromToken(db: SqlDb, token: string | undefined): Promise<UserRow | null> {
  if (!token) return null
  const session = await one<SessionRow>(db, `SELECT * FROM sessions WHERE token_hash = ?`, sha256(token))
  if (!session || session.revoked_at || session.expires_at < nowIso()) return null
  const user = await one<UserRow>(db, `SELECT * FROM users WHERE id = ? AND deleted_at IS NULL`, session.user_id)
  return user ?? null
}

export async function revokeToken(db: SqlDb, token: string | undefined): Promise<void> {
  if (!token) return
  await run(db, `UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`, nowIso(), sha256(token))
}

export async function listInvitations(db: SqlDb, adminId: string) {
  const rows = await many<InvitationRow>(
    db,
    `SELECT id, code_hash, created_by, max_uses, use_count, expires_at, revoked_at, created_at, note
     FROM invitations WHERE created_by = ? ORDER BY created_at DESC`,
    adminId
  )
  return rows.map((row) => ({
    id: row.id,
    maxUses: row.max_uses,
    useCount: row.use_count,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    note: row.note,
  }))
}
