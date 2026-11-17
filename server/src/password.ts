import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'

const N = 16384
const r = 8
const p = 1

function scrypt(password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number }) {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (error, derived) => {
      if (error) reject(error)
      else resolve(derived as Buffer)
    })
  })
}

export function assertPasswordPolicy(password: string): void {
  if (typeof password !== 'string' || password.length < 12 || password.length > 200) {
    throw new Error('password_policy')
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = await scrypt(password, salt, 32, { N, r, p })
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${hash.toString('base64url')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const rounds = Number(parts[1])
  const block = Number(parts[2])
  const parallel = Number(parts[3])
  if (!Number.isFinite(rounds) || !Number.isFinite(block) || !Number.isFinite(parallel)) return false
  const salt = Buffer.from(parts[4], 'base64url')
  const expected = Buffer.from(parts[5], 'base64url')
  const hash = await scrypt(password, salt, expected.length, { N: rounds, r: block, p: parallel })
  if (hash.length !== expected.length) return false
  return timingSafeEqual(hash, expected)
}
