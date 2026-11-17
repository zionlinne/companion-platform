import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { AppConfig } from './config.ts'
import { many, one, run, withTx } from './db.ts'
import { HttpError, newId, nowIso, sha256 } from './http.ts'
import type { InvitationRow } from './types.ts'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

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
  for (let i = 0; i < 12; i += 1) out += ALPHABET[bytes[i]! % ALPHABET.length]
  return formatCode(out)
}

export function insertQuota(db: DatabaseSync, userId: string, config: AppConfig, at: string): void {
  run(
    db,
    `INSERT INTO quotas (user_id, daily_request_limit, daily_token_limit, updated_at) VALUES (?, ?, ?, ?)`,
    userId,
    config.defaultDailyRequests,
    config.defaultDailyTokens,
    at
  )
}

export function createInvitations(
  db: DatabaseSync,
  adminId: string,
  count: number,
  maxUses = 1,
  note: string | null = null,
  expiresAt: string | null = null
): Array<{ id: string; code: string; maxUses: number; expiresAt: string | null }> {
  if (!Number.isInteger(count) || count < 1 || count > 50) {
    throw new HttpError(400, 'invalid_count', 'Invitation count must be 1-50')
  }
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 20) {
    throw new HttpError(400, 'invalid_field', 'maxUses must be 1-20')
  }
  if (expiresAt !== null && Number.isNaN(Date.parse(expiresAt))) {
    throw new HttpError(400, 'invalid_field', 'expiresAt must be an ISO timestamp')
  }
  const created: Array<{ id: string; code: string; maxUses: number; expiresAt: string | null }> = []
  const at = nowIso()
  withTx(db, () => {
    for (let i = 0; i < count; i += 1) {
      const code = randomCode()
      const id = newId()
      run(
        db,
        `INSERT INTO invitations (id, code_hash, created_by, max_uses, use_count, expires_at, revoked_at, created_at, note)
         VALUES (?, ?, ?, ?, 0, ?, NULL, ?, ?)`,
        id,
        hashInvite(code),
        adminId,
        maxUses,
        expiresAt,
        at,
        note
      )
      created.push({ id, code, maxUses, expiresAt })
    }
  })
  return created
}

export function consumeInvitation(db: DatabaseSync, code: string, userId: string): void {
  const at = nowIso()
  const invite = one<InvitationRow>(db, `SELECT * FROM invitations WHERE code_hash = ?`, hashInvite(code || ''))
  if (!invite || invite.revoked_at) throw new HttpError(400, 'invitation_invalid', 'Invitation code is invalid')
  if (invite.expires_at && invite.expires_at < at) throw new HttpError(400, 'invitation_expired', 'Invitation code is expired')
  const changed = run(
    db,
    `UPDATE invitations
     SET use_count = use_count + 1
     WHERE id = ? AND use_count < max_uses AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at >= ?)`,
    invite.id,
    at
  )
  if (changed !== 1) throw new HttpError(400, 'invitation_invalid', 'Invitation code is invalid')
  run(
    db,
    `INSERT INTO invitation_redemptions (id, invitation_id, user_id, created_at) VALUES (?, ?, ?, ?)`,
    newId(),
    invite.id,
    userId,
    at
  )
}

export function listInvitations(db: DatabaseSync, adminId: string) {
  return many<InvitationRow>(
    db,
    `SELECT id, code_hash, created_by, max_uses, use_count, expires_at, revoked_at, created_at, note
     FROM invitations WHERE created_by = ? ORDER BY created_at DESC`,
    adminId
  ).map((row) => ({
    id: row.id,
    maxUses: row.max_uses,
    useCount: row.use_count,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    note: row.note,
  }))
}
