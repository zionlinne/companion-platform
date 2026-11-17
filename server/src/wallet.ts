import type { AppConfig } from './config.ts'
import { isUniqueViolation, many, one, run, withTx, type SqlDb } from './db.ts'
import { HttpError, newId, nowIso } from './http.ts'
import { fenFromMicroUsd, formatFen, PRESET_FEN, tokensToMinor, userChargeFen } from './money.ts'
import { costMicroUsd } from './prompt.ts'

export type BillingState = 'off' | 'unpriced' | 'ready'

export type WalletRow = {
  user_id: string
  available_fen: number
  frozen_fen: number
  recharge_fen: number
  spent_fen: number
  refund_fen: number
  updated_at: string
}

export type RechargeOrderRow = {
  id: string
  user_id: string
  amount_fen: number
  status: 'pending' | 'submitted' | 'paid' | 'rejected' | 'cancelled'
  provider: string
  request_id: string
  user_reference: string | null
  payment_reference: string | null
  review_note: string | null
  reviewed_by: string | null
  reviewed_at: string | null
  created_at: string
  submitted_at: string | null
  paid_at: string | null
}

type ChargeQuote = {
  costFen: number | null
  chargeFen: number | null
  marginBps: number
  status: 'quoted' | 'unknown' | 'fixture' | 'unpriced'
  note: string
}

const QR_ID = 'alipay'
const MAX_QR_BYTES = 200_000

export function billingState(config: AppConfig): BillingState {
  if (!config.billingEnabled) return 'off'
  if (config.priceCurrency === 'unset' || Object.keys(config.prices).length === 0) return 'unpriced'
  if (config.priceCurrency === 'USD') {
    if (!config.fxSource || !config.fxQuotedAt || config.fxCnyFenPerUsd === null) return 'unpriced'
  }
  return 'ready'
}

export function billingDisclosure(config: AppConfig): { state: BillingState; marginBps: number; note: string } {
  const state = billingState(config)
  const marginBps = config.marginBps
  if (state === 'off') {
    return {
      state,
      marginBps,
      note: '商业计费没有开启。当前内测聊天不扣余额。充值余额不会被用来支付聊天，避免看起来像已经按次扣费。',
    }
  }
  if (state === 'unpriced') {
    return {
      state,
      marginBps,
      note: '计费开关已打开，但没有同时配好可验证的单价和币种（美元还需要汇率来源、汇率和时间）。系统不会猜测 token 价格，也不会扣余额。',
    }
  }
  return {
    state,
    marginBps,
    note: '商业计费已开启。真实模型用量按 UserCharge = C / (1 - M) 入账，M 来自 MARGIN_BPS，默认 30%，不是直接乘 1.3。协议夹具用量不扣余额。记忆提取、主动消息和记忆建议若再调用一次模型，使用单独的请求号记一笔，不和聊天回复重复计算。没有用量或单价时记为未计价，不扣余额。',
  }
}

export async function ensureWallet(db: SqlDb, userId: string, at = nowIso()): Promise<void> {
  const existing = await one<{ user_id: string }>(db, `SELECT user_id FROM wallets WHERE user_id = ?`, userId)
  if (existing) return
  try {
    await run(
      db,
      `INSERT INTO wallets (user_id, available_fen, frozen_fen, recharge_fen, spent_fen, refund_fen, updated_at)
       VALUES (?, 0, 0, 0, 0, 0, ?)`,
      userId,
      at
    )
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
  }
}

export async function readWallet(db: SqlDb, userId: string): Promise<WalletRow> {
  await ensureWallet(db, userId)
  const row = await one<WalletRow>(db, `SELECT * FROM wallets WHERE user_id = ?`, userId)
  if (!row) throw new HttpError(500, 'wallet_missing', 'Wallet could not be created')
  return row
}

export function walletJson(row: WalletRow) {
  return {
    availableFen: row.available_fen,
    frozenFen: row.frozen_fen,
    rechargeFen: row.recharge_fen,
    spentFen: row.spent_fen,
    refundFen: row.refund_fen,
    availableYuan: formatFen(row.available_fen),
    updatedAt: row.updated_at,
  }
}

export function assertPresetFen(amountFen: number): void {
  if (!PRESET_FEN.includes(amountFen as (typeof PRESET_FEN)[number])) {
    throw new HttpError(400, 'invalid_amount', '充值金额只能是 5、10、20、50 或 100 元，由服务端定价。')
  }
}

function quoteCharge(
  config: AppConfig,
  model: string,
  promptTokens: number | null,
  completionTokens: number | null,
  source: 'live' | 'fixture'
): ChargeQuote {
  const marginBps = config.marginBps
  const unknown = (note: string, status: ChargeQuote['status'] = 'unknown'): ChargeQuote => ({
    costFen: null,
    chargeFen: null,
    marginBps,
    status,
    note,
  })
  if (billingState(config) !== 'ready') return unknown('商业计费未就绪，不扣余额。', 'unpriced')
  if (source === 'fixture') {
    return unknown('协议夹具用量不是供应商账单，不扣余额。', 'fixture')
  }
  if (promptTokens === null || completionTokens === null) {
    return unknown('供应商没有返回用量，不猜测价格，不扣余额。')
  }
  const price = config.prices[model]
  if (!price) return unknown('这个模型没有配置单价，不猜测价格，不扣余额。')
  try {
    if (config.priceCurrency === 'CNY') {
      const costFen = tokensToMinor(promptTokens, completionTokens, price.input_per_million, price.output_per_million)
      const chargeFen = userChargeFen(costFen, marginBps)
      return {
        costFen,
        chargeFen,
        marginBps,
        status: 'quoted',
        note: '按已配置的人民币分单价和上报用量估算，不是供应商发票。',
      }
    }
    const priced = costMicroUsd(model, promptTokens, completionTokens, config.prices, source)
    if (priced.cost === null || config.fxCnyFenPerUsd === null) return unknown('美元单价无法换成人民币分，不扣余额。')
    const costFen = fenFromMicroUsd(priced.cost, config.fxCnyFenPerUsd)
    const chargeFen = userChargeFen(costFen, marginBps)
    return {
      costFen,
      chargeFen,
      marginBps,
      status: 'quoted',
      note: '按已配置的美元单价、汇率和上报用量估算，不是供应商发票。',
    }
  } catch {
    return unknown('单价不是可计算的整数，不猜测价格，不扣余额。')
  }
}

export async function openBill(db: SqlDb, config: AppConfig, userId: string, requestId: string): Promise<{ held: boolean }> {
  if (billingState(config) !== 'ready') return { held: false }
  const reserve = config.billingReserveFen
  return await withTx(db, async () => {
    await ensureWallet(db, userId)
    const existing = await one<{ amount_fen: number }>(
      db,
      `SELECT amount_fen FROM wallet_transactions WHERE request_id = ? AND entry = 'freeze'`,
      requestId
    )
    if (existing) return { held: true }
    const wallet = await one<WalletRow>(db, `SELECT * FROM wallets WHERE user_id = ?`, userId)
    if (!wallet || wallet.available_fen <= 0) {
      throw new HttpError(402, 'insufficient_balance', '余额不足。这次没有调用模型，也没有扣费。')
    }
    if (reserve === 0) return { held: false }
    const changed = await run(
      db,
      `UPDATE wallets
       SET available_fen = available_fen - ?, frozen_fen = frozen_fen + ?, updated_at = ?
       WHERE user_id = ? AND available_fen >= ?`,
      reserve,
      reserve,
      nowIso(),
      userId,
      reserve
    )
    if (changed !== 1) throw new HttpError(402, 'insufficient_balance', '余额不足。这次没有调用模型，也没有扣费。')
    await run(
      db,
      `INSERT INTO wallet_transactions (id, user_id, request_id, entry, amount_fen, note, created_at)
       VALUES (?, ?, ?, 'freeze', ?, 'billing hold', ?)`,
      newId(),
      userId,
      requestId,
      -reserve,
      nowIso()
    )
    return { held: true }
  })
}

export async function abortBill(db: SqlDb, userId: string, requestId: string): Promise<void> {
  await withTx(db, async () => {
    const settled = await one<{ id: string }>(db, `SELECT id FROM model_usage_records WHERE request_id = ?`, requestId)
    if (settled) return
    const released = await one<{ id: string }>(
      db,
      `SELECT id FROM wallet_transactions WHERE request_id = ? AND entry = 'release'`,
      requestId
    )
    if (released) return
    const hold = await one<{ amount_fen: number }>(
      db,
      `SELECT amount_fen FROM wallet_transactions WHERE request_id = ? AND entry = 'freeze'`,
      requestId
    )
    if (!hold) return
    const amount = Math.abs(hold.amount_fen)
    const changed = await run(
      db,
      `UPDATE wallets
       SET available_fen = available_fen + ?, frozen_fen = frozen_fen - ?, updated_at = ?
       WHERE user_id = ? AND frozen_fen >= ?`,
      amount,
      amount,
      nowIso(),
      userId,
      amount
    )
    if (changed !== 1) return
    await run(
      db,
      `INSERT INTO wallet_transactions (id, user_id, request_id, entry, amount_fen, note, created_at)
       VALUES (?, ?, ?, 'release', ?, 'hold released', ?)`,
      newId(),
      userId,
      requestId,
      amount,
      nowIso()
    )
  })
}

export async function closeBill(
  db: SqlDb,
  config: AppConfig,
  input: {
    userId: string
    requestId: string
    kind: 'chat' | 'memory' | 'initiative' | 'suggest'
    model: string
    promptTokens: number | null
    completionTokens: number | null
    source: 'live' | 'fixture'
  }
): Promise<{ status: string; idempotent: boolean }> {
  if (billingState(config) !== 'ready') return { status: 'not_billed', idempotent: false }
  const quote = quoteCharge(config, input.model, input.promptTokens, input.completionTokens, input.source)
  return await withTx(db, async () => {
    const existing = await one<{ status: string }>(db, `SELECT status FROM model_usage_records WHERE request_id = ?`, input.requestId)
    if (existing) return { status: existing.status, idempotent: true }
    await ensureWallet(db, input.userId)
    const at = nowIso()
    const hold = await one<{ amount_fen: number }>(
      db,
      `SELECT amount_fen FROM wallet_transactions WHERE request_id = ? AND entry = 'freeze'`,
      input.requestId
    )
    const held = hold ? Math.abs(hold.amount_fen) : 0
    let status = quote.status === 'quoted' ? 'settled' : quote.status
    let charged: number | null = null
    if (quote.chargeFen === null || quote.costFen === null) {
      if (held > 0) await releaseHold(db, input.userId, input.requestId, held, at)
      status = quote.status === 'fixture' ? 'fixture' : 'unknown'
    } else {
      const extra = Math.max(0, quote.chargeFen - held)
      const wallet = await one<WalletRow>(db, `SELECT * FROM wallets WHERE user_id = ?`, input.userId)
      const affordable = Boolean(wallet) && (wallet?.available_fen ?? 0) >= extra
      if (!affordable) {
        if (held > 0) await releaseHold(db, input.userId, input.requestId, held, at)
        status = 'unknown'
      } else {
        if (extra > 0) {
          const changed = await run(
            db,
            `UPDATE wallets SET available_fen = available_fen - ?, updated_at = ? WHERE user_id = ? AND available_fen >= ?`,
            extra,
            at,
            input.userId,
            extra
          )
          if (changed !== 1) {
            if (held > 0) await releaseHold(db, input.userId, input.requestId, held, at)
            status = 'unknown'
          }
        }
        if (status === 'settled') {
          if (held > 0) {
            await run(
              db,
              `UPDATE wallets SET frozen_fen = frozen_fen - ?, updated_at = ? WHERE user_id = ? AND frozen_fen >= ?`,
              held,
              at,
              input.userId,
              held
            )
          }
          const unused = held - quote.chargeFen
          if (unused > 0) {
            await run(db, `UPDATE wallets SET available_fen = available_fen + ?, updated_at = ? WHERE user_id = ?`, unused, at, input.userId)
            await run(
              db,
              `INSERT INTO wallet_transactions (id, user_id, request_id, entry, amount_fen, note, created_at)
               VALUES (?, ?, ?, 'release', ?, 'unused hold returned', ?)`,
              newId(),
              input.userId,
              input.requestId,
              unused,
              at
            )
          }
          await run(db, `UPDATE wallets SET spent_fen = spent_fen + ?, updated_at = ? WHERE user_id = ?`, quote.chargeFen, at, input.userId)
          await run(
            db,
            `INSERT INTO wallet_transactions (id, user_id, request_id, entry, amount_fen, note, created_at)
             VALUES (?, ?, ?, 'settle', ?, ?, ?)`,
            newId(),
            input.userId,
            input.requestId,
            -quote.chargeFen,
            quote.note,
            at
          )
          charged = quote.chargeFen
        }
      }
    }
    await run(
      db,
      `INSERT INTO model_usage_records (
         id, user_id, request_id, kind, model, prompt_tokens, completion_tokens,
         cost_fen, charge_fen, margin_bps, status, source, note, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId(),
      input.userId,
      input.requestId,
      input.kind,
      input.model,
      input.promptTokens,
      input.completionTokens,
      status === 'settled' ? quote.costFen : null,
      charged,
      quote.marginBps,
      status,
      input.source,
      status === 'settled' ? quote.note : `${quote.note} 未入账。`,
      at
    )
    return { status, idempotent: false }
  })
}

async function releaseHold(db: SqlDb, userId: string, requestId: string, held: number, at: string) {
  const already = await one<{ id: string }>(db, `SELECT id FROM wallet_transactions WHERE request_id = ? AND entry = 'release'`, requestId)
  if (already) return
  const changed = await run(
    db,
    `UPDATE wallets
     SET available_fen = available_fen + ?, frozen_fen = frozen_fen - ?, updated_at = ?
     WHERE user_id = ? AND frozen_fen >= ?`,
    held,
    held,
    at,
    userId,
    held
  )
  if (changed !== 1) return
  await run(
    db,
    `INSERT INTO wallet_transactions (id, user_id, request_id, entry, amount_fen, note, created_at)
     VALUES (?, ?, ?, 'release', ?, 'hold released', ?)`,
    newId(),
    userId,
    requestId,
    held,
    at
  )
}

export function orderJson(row: RechargeOrderRow, email?: string) {
  return {
    id: row.id,
    amountFen: row.amount_fen,
    amountYuan: formatFen(row.amount_fen),
    status: row.status,
    provider: row.provider,
    creditMode: 'admin_manual' as const,
    userReference: row.user_reference,
    paymentReference: row.status === 'paid' ? row.payment_reference : null,
    reviewNote: row.review_note,
    createdAt: row.created_at,
    submittedAt: row.submitted_at,
    paidAt: row.paid_at,
    reviewedAt: row.reviewed_at,
    ...(email ? { email } : {}),
  }
}

export function presetsJson() {
  return PRESET_FEN.map((fen) => ({ amountFen: fen, amountYuan: formatFen(fen) }))
}

function sniffImage(bytes: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp'
  return null
}

export function decodeQrImage(imageBase64: string): { mime: 'image/png' | 'image/jpeg' | 'image/webp'; base64: string; bytes: number } {
  if (typeof imageBase64 !== 'string' || imageBase64.length === 0 || imageBase64.length > MAX_QR_BYTES * 2) {
    throw new HttpError(400, 'invalid_qr', '收款码图片为空或超过 200KB。')
  }
  const cleaned = imageBase64.replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '')
  const bytes = Buffer.from(cleaned, 'base64')
  if (bytes.length === 0 || bytes.length > MAX_QR_BYTES) throw new HttpError(400, 'invalid_qr', '收款码图片为空或超过 200KB。')
  const mime = sniffImage(bytes)
  if (!mime) throw new HttpError(400, 'invalid_qr', '收款码只接受 PNG、JPEG 或 WebP，不会生成图片。')
  return { mime, base64: bytes.toString('base64'), bytes: bytes.length }
}

export async function qrStatus(db: SqlDb): Promise<{ enabled: boolean; mime: string | null; updatedAt: string | null }> {
  const row = await one<{ mime: string; enabled: number; updated_at: string }>(
    db,
    `SELECT mime, enabled, updated_at FROM payment_qrcodes WHERE id = ?`,
    QR_ID
  )
  if (!row || row.enabled !== 1) return { enabled: false, mime: null, updatedAt: row?.updated_at ?? null }
  return { enabled: true, mime: row.mime, updatedAt: row.updated_at }
}

export async function qrBytes(db: SqlDb): Promise<{ mime: string; bytes: Buffer } | null> {
  const row = await one<{ mime: string; image_base64: string; enabled: number }>(
    db,
    `SELECT mime, image_base64, enabled FROM payment_qrcodes WHERE id = ?`,
    QR_ID
  )
  if (!row || row.enabled !== 1) return null
  return { mime: row.mime, bytes: Buffer.from(row.image_base64, 'base64') }
}

export async function saveQr(db: SqlDb, adminId: string, imageBase64: string): Promise<{ mime: string; bytes: number }> {
  const image = decodeQrImage(imageBase64)
  const at = nowIso()
  await run(
    db,
    `INSERT INTO payment_qrcodes (id, provider, mime, image_base64, byte_size, enabled, updated_by, updated_at)
     VALUES (?, 'alipay_manual', ?, ?, ?, 1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       mime = excluded.mime,
       image_base64 = excluded.image_base64,
       byte_size = excluded.byte_size,
       enabled = 1,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`,
    QR_ID,
    image.mime,
    image.base64,
    image.bytes,
    adminId,
    at
  )
  return { mime: image.mime, bytes: image.bytes }
}

export async function disableQr(db: SqlDb, adminId: string): Promise<void> {
  await run(
    db,
    `UPDATE payment_qrcodes SET enabled = 0, updated_by = ?, updated_at = ? WHERE id = ?`,
    adminId,
    nowIso(),
    QR_ID
  )
}

function referenceOrNull(value: string): string | null {
  const text = value.trim()
  if (!text) return null
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(text)) {
    throw new HttpError(400, 'invalid_reference', '付款参考只能是 6 到 64 位字母、数字、下划线或连字符。')
  }
  return text
}

export async function createRechargeOrder(
  db: SqlDb,
  userId: string,
  amountFen: number,
  requestId: string
): Promise<RechargeOrderRow> {
  assertPresetFen(amountFen)
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(requestId)) {
    throw new HttpError(400, 'invalid_request', 'requestId 必须是 8 到 80 位字母、数字、下划线或连字符。')
  }
  const qr = await qrStatus(db)
  if (!qr.enabled) throw new HttpError(409, 'qr_not_configured', '支付宝收款码还没有配置，不能创建充值申请。')
  const existing = await one<RechargeOrderRow>(db, `SELECT * FROM recharge_orders WHERE request_id = ?`, requestId)
  if (existing) {
    if (existing.user_id !== userId || existing.amount_fen !== amountFen) {
      throw new HttpError(409, 'request_conflict', '这个请求号已经用于另一笔申请。')
    }
    return existing
  }
  const at = nowIso()
  const row: RechargeOrderRow = {
    id: newId(),
    user_id: userId,
    amount_fen: amountFen,
    status: 'pending',
    provider: 'alipay_manual',
    request_id: requestId,
    user_reference: null,
    payment_reference: null,
    review_note: null,
    reviewed_by: null,
    reviewed_at: null,
    created_at: at,
    submitted_at: null,
    paid_at: null,
  }
  try {
    await run(
      db,
      `INSERT INTO recharge_orders (
         id, user_id, amount_fen, status, provider, request_id, user_reference, payment_reference,
         review_note, reviewed_by, reviewed_at, created_at, submitted_at, paid_at
       ) VALUES (?, ?, ?, 'pending', 'alipay_manual', ?, NULL, NULL, NULL, NULL, NULL, ?, NULL, NULL)`,
      row.id,
      row.user_id,
      row.amount_fen,
      row.request_id,
      at
    )
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    const raced = await one<RechargeOrderRow>(db, `SELECT * FROM recharge_orders WHERE request_id = ?`, requestId)
    if (!raced || raced.user_id !== userId || raced.amount_fen !== amountFen) {
      throw new HttpError(409, 'request_conflict', '这个请求号已经用于另一笔申请。')
    }
    return raced
  }
  return row
}

export async function submitUserReference(db: SqlDb, userId: string, orderId: string, reference: string): Promise<RechargeOrderRow> {
  const claim = referenceOrNull(reference)
  if (!claim) throw new HttpError(400, 'invalid_reference', '付款参考不能为空。提交参考不会入账。')
  const changed = await run(
    db,
    `UPDATE recharge_orders
     SET user_reference = ?, status = 'submitted', submitted_at = COALESCE(submitted_at, ?)
     WHERE id = ? AND user_id = ? AND status IN ('pending', 'submitted')`,
    claim,
    nowIso(),
    orderId,
    userId
  )
  const row = await one<RechargeOrderRow>(db, `SELECT * FROM recharge_orders WHERE id = ? AND user_id = ?`, orderId, userId)
  if (!row) throw new HttpError(404, 'not_found', 'Not found')
  if (changed !== 1 && row.status !== 'submitted') {
    throw new HttpError(409, 'order_closed', '这笔申请已经结束，不能再提交付款参考。')
  }
  return row
}

export async function cancelRecharge(db: SqlDb, userId: string, orderId: string): Promise<RechargeOrderRow> {
  await run(
    db,
    `UPDATE recharge_orders SET status = 'cancelled', reviewed_at = ? WHERE id = ? AND user_id = ? AND status IN ('pending', 'submitted')`,
    nowIso(),
    orderId,
    userId
  )
  const row = await one<RechargeOrderRow>(db, `SELECT * FROM recharge_orders WHERE id = ? AND user_id = ?`, orderId, userId)
  if (!row) throw new HttpError(404, 'not_found', 'Not found')
  if (row.status === 'paid') throw new HttpError(409, 'order_closed', '已经入账的申请不能取消。')
  return row
}

function reviewNote(note: string): string {
  const text = note.trim()
  if (text.length < 1 || text.length > 200) throw new HttpError(400, 'invalid_field', '审核说明需要 1 到 200 字。')
  return text
}

export async function confirmRecharge(
  db: SqlDb,
  adminId: string,
  orderId: string,
  input: { paymentReference: string; note: string; acknowledged: boolean }
): Promise<{ order: RechargeOrderRow; credited: boolean }> {
  if (input.acknowledged !== true) {
    throw new HttpError(400, 'confirmation_required', '确认入账需要另一次明确操作。只提交付款参考不会加余额。')
  }
  const paymentReference = referenceOrNull(input.paymentReference)
  if (!paymentReference) throw new HttpError(400, 'invalid_reference', '需要管理员从支付宝账单抄录的唯一流水。')
  const note = reviewNote(input.note)
  try {
    return await withTx(db, async () => {
      const order = await one<RechargeOrderRow>(db, `SELECT * FROM recharge_orders WHERE id = ?`, orderId)
      if (!order) throw new HttpError(404, 'not_found', 'Not found')
      if (order.status === 'paid') {
        if (order.payment_reference === paymentReference) return { order, credited: false }
        throw new HttpError(409, 'order_closed', '这笔申请已经用另一条流水入账。')
      }
      if (order.status !== 'pending' && order.status !== 'submitted') {
        throw new HttpError(409, 'order_closed', '拒绝、取消或未完成的申请不能入账。')
      }
      const duplicate = await one<{ id: string }>(
        db,
        `SELECT id FROM recharge_orders WHERE payment_reference = ? AND id <> ?`,
        paymentReference,
        orderId
      )
      if (duplicate) throw new HttpError(409, 'duplicate_payment_reference', '这条支付宝流水已经入过账，不能再次加余额。')
      const at = nowIso()
      const changed = await run(
        db,
        `UPDATE recharge_orders
         SET status = 'paid', payment_reference = ?, review_note = ?, reviewed_by = ?, reviewed_at = ?, paid_at = ?
         WHERE id = ? AND status IN ('pending', 'submitted') AND payment_reference IS NULL`,
        paymentReference,
        note,
        adminId,
        at,
        at,
        orderId
      )
      if (changed !== 1) {
        const current = await one<RechargeOrderRow>(db, `SELECT * FROM recharge_orders WHERE id = ?`, orderId)
        if (current?.status === 'paid' && current.payment_reference === paymentReference) return { order: current, credited: false }
        throw new HttpError(409, 'order_closed', '这笔申请已经处理过。')
      }
      await ensureWallet(db, order.user_id)
      const walletChanged = await run(
        db,
        `UPDATE wallets
         SET available_fen = available_fen + ?, recharge_fen = recharge_fen + ?, updated_at = ?
         WHERE user_id = ?`,
        order.amount_fen,
        order.amount_fen,
        at,
        order.user_id
      )
      if (walletChanged !== 1) throw new HttpError(500, 'wallet_missing', 'Wallet could not be credited')
      await run(
        db,
        `INSERT INTO wallet_transactions (id, user_id, request_id, entry, amount_fen, note, created_at)
         VALUES (?, ?, ?, 'recharge', ?, 'admin confirmed alipay receipt', ?)`,
        newId(),
        order.user_id,
        `recharge:${order.id}`,
        order.amount_fen,
        at
      )
      await run(
        db,
        `INSERT INTO admin_audit_logs (id, actor_id, action, target_id, note, created_at)
         VALUES (?, ?, 'recharge_confirm', ?, '管理员确认到账后入账', ?)`,
        newId(),
        adminId,
        order.id,
        at
      )
      const paid = await one<RechargeOrderRow>(db, `SELECT * FROM recharge_orders WHERE id = ?`, orderId)
      if (!paid) throw new HttpError(404, 'not_found', 'Not found')
      return { order: paid, credited: true }
    })
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new HttpError(409, 'duplicate_payment_reference', '这条支付宝流水已经入过账，不能再次加余额。')
    }
    throw error
  }
}

export async function rejectRecharge(
  db: SqlDb,
  adminId: string,
  orderId: string,
  input: { note: string; acknowledged: boolean }
): Promise<RechargeOrderRow> {
  if (input.acknowledged !== true) {
    throw new HttpError(400, 'confirmation_required', '拒绝也需要明确确认。拒绝不会加余额。')
  }
  const note = reviewNote(input.note)
  return await withTx(db, async () => {
    const order = await one<RechargeOrderRow>(db, `SELECT * FROM recharge_orders WHERE id = ?`, orderId)
    if (!order) throw new HttpError(404, 'not_found', 'Not found')
    if (order.status === 'rejected') return order
    if (order.status === 'paid') throw new HttpError(409, 'order_closed', '已经入账的申请不能拒绝。')
    const at = nowIso()
    const changed = await run(
      db,
      `UPDATE recharge_orders
       SET status = 'rejected', review_note = ?, reviewed_by = ?, reviewed_at = ?
       WHERE id = ? AND status IN ('pending', 'submitted')`,
      note,
      adminId,
      at,
      orderId
    )
    if (changed !== 1) {
      const current = await one<RechargeOrderRow>(db, `SELECT * FROM recharge_orders WHERE id = ?`, orderId)
      if (current?.status === 'rejected') return current
      throw new HttpError(409, 'order_closed', '这笔申请已经处理过。')
    }
    await run(
      db,
      `INSERT INTO admin_audit_logs (id, actor_id, action, target_id, note, created_at)
       VALUES (?, ?, 'recharge_reject', ?, '管理员拒绝，未入账', ?)`,
      newId(),
      adminId,
      order.id,
      at
    )
    const rejected = await one<RechargeOrderRow>(db, `SELECT * FROM recharge_orders WHERE id = ?`, orderId)
    if (!rejected) throw new HttpError(404, 'not_found', 'Not found')
    return rejected
  })
}

export async function listOwnOrders(db: SqlDb, userId: string): Promise<RechargeOrderRow[]> {
  return many<RechargeOrderRow>(
    db,
    `SELECT * FROM recharge_orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
    userId
  )
}

export async function listLedger(db: SqlDb, userId: string) {
  return many<{ id: string; request_id: string; entry: string; amount_fen: number; note: string; created_at: string }>(
    db,
    `SELECT id, request_id, entry, amount_fen, note, created_at
     FROM wallet_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
    userId
  )
}

export async function listUsage(db: SqlDb, userId: string) {
  return many<{
    id: string
    request_id: string
    kind: string
    model: string
    prompt_tokens: number | null
    completion_tokens: number | null
    cost_fen: number | null
    charge_fen: number | null
    status: string
    source: string
    note: string
    created_at: string
  }>(
    db,
    `SELECT id, request_id, kind, model, prompt_tokens, completion_tokens, cost_fen, charge_fen, status, source, note, created_at
     FROM model_usage_records WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
    userId
  )
}
