import type { DatabaseSync } from 'node:sqlite'
import type { AppConfig, ModelPrice } from './config.ts'
import { many, one, run, withTx } from './db.ts'
import { HttpError, newId, nowIso } from './http.ts'
import { fenFromMicroUsd, formatFen, PRESET_FEN, tokensToMinor, userChargeFen } from './money.ts'

export type WalletRow = {
  user_id: string
  available_fen: number
  frozen_fen: number
  recharge_fen: number
  spent_fen: number
  refund_fen: number
  created_at: string
}

type LedgerRow = {
  id: string
  user_id: string
  amount_fen: number
  currency: string
  unit: string
  type: string
  status: string
  entry: string
  request_id: string
  related_id: string | null
  reason: string | null
  created_at: string
}

export function billingMode(config: AppConfig): 'cny' | 'fx' | 'blocked_fx' | 'off' {
  if (Object.keys(config.prices).length === 0 || config.priceCurrency === 'unset') return 'off'
  if (config.priceCurrency === 'CNY') return 'cny'
  if (config.fxCnyFenPerUsd !== null && config.fxSource && config.fxQuotedAt) return 'fx'
  return 'blocked_fx'
}

export function marginBps(db: DatabaseSync, config: AppConfig): number {
  const row = one<{ value: string }>(db, `SELECT value FROM app_settings WHERE key = 'margin_bps'`)
  const parsed = row ? Number(row.value) : config.marginBps
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed >= 10_000) return config.marginBps
  return parsed
}

export function gatewayPaused(db: DatabaseSync): boolean {
  const row = one<{ value: string }>(db, `SELECT value FROM app_settings WHERE key = 'gateway_paused'`)
  return row?.value === '1'
}

export function walletView(row: WalletRow) {
  return {
    availableFen: row.available_fen,
    frozenFen: row.frozen_fen,
    rechargeFen: row.recharge_fen,
    spentFen: row.spent_fen,
    refundFen: row.refund_fen,
    availableDisplay: formatFen(row.available_fen),
    frozenDisplay: formatFen(row.frozen_fen),
    rechargeDisplay: formatFen(row.recharge_fen),
    spentDisplay: formatFen(row.spent_fen),
    refundDisplay: formatFen(row.refund_fen),
    currency: 'CNY',
    unit: 'fen',
    realPayment: false,
  }
}

export function ownWallet(db: DatabaseSync, userId: string): WalletRow {
  const row = one<WalletRow>(db, `SELECT * FROM wallets WHERE user_id = ?`, userId)
  if (!row) throw new HttpError(404, 'wallet_missing', 'Wallet not found')
  return row
}

function ledgerJson(row: LedgerRow) {
  return {
    id: row.id,
    amountFen: row.amount_fen,
    amountDisplay: formatFen(row.amount_fen),
    currency: row.currency,
    unit: row.unit,
    type: row.type,
    status: row.status,
    entry: row.entry,
    requestId: row.request_id,
    relatedId: row.related_id,
    reason: row.reason,
    createdAt: row.created_at,
  }
}

export function listLedger(db: DatabaseSync, userId: string) {
  return many<LedgerRow>(
    db,
    `SELECT * FROM wallet_transactions WHERE user_id = ? ORDER BY created_at, id`,
    userId
  ).map(ledgerJson)
}

export function assertPresetFen(amountFen: number): void {
  if (!PRESET_FEN.includes(amountFen as (typeof PRESET_FEN)[number])) {
    throw new HttpError(400, 'invalid_amount', 'Recharge amount must be one of 500, 1000, 2000, 5000, 10000 fen')
  }
}

export function createRechargeOrder(db: DatabaseSync, userId: string, amountFen: number, requestId: string) {
  assertPresetFen(amountFen)
  if (!requestId || requestId.length > 80) throw new HttpError(400, 'invalid_field', 'requestId is required')
  return withTx(db, () => {
    const existing = one<{ id: string; amount_fen: number; status: string; user_id: string }>(
      db,
      `SELECT id, amount_fen, status, user_id FROM recharge_orders WHERE request_id = ?`,
      requestId
    )
    if (existing) {
      if (existing.user_id !== userId) throw new HttpError(409, 'request_conflict', 'requestId belongs to another order')
      return { id: existing.id, amountFen: existing.amount_fen, status: existing.status, created: false }
    }
    const id = newId()
    const at = nowIso()
    run(
      db,
      `INSERT INTO recharge_orders (id, user_id, amount_fen, status, provider, request_id, created_at, paid_at)
       VALUES (?, ?, ?, 'pending', 'unconfigured', ?, ?, NULL)`,
      id,
      userId,
      amountFen,
      requestId,
      at
    )
    return { id, amountFen, status: 'pending' as const, created: true }
  })
}

export function confirmTestRecharge(db: DatabaseSync, config: AppConfig, userId: string, orderId: string) {
  if (!config.allowTestPayments) {
    throw new HttpError(403, 'test_payments_disabled', '测试入账适配器没有打开。真实支付未接入，这笔订单不会到账。')
  }
  return withTx(db, () => {
    const order = one<{ id: string; user_id: string; amount_fen: number; status: string; request_id: string }>(
      db,
      `SELECT id, user_id, amount_fen, status, request_id FROM recharge_orders WHERE id = ?`,
      orderId
    )
    if (!order || order.user_id !== userId) throw new HttpError(404, 'not_found', 'Not found')
    const prior = one<{ id: string }>(db, `SELECT id FROM wallet_transactions WHERE request_id = ? AND entry = 'recharge'`, order.request_id)
    if (order.status === 'paid' || prior) {
      return { orderId: order.id, amountFen: order.amount_fen, credited: false, alreadyPosted: true, realCredit: false, adapter: 'test' }
    }
    if (order.status !== 'pending') throw new HttpError(409, 'order_closed', 'Order cannot be confirmed')
    run(
      db,
      `UPDATE wallets SET available_fen = available_fen + ?, recharge_fen = recharge_fen + ? WHERE user_id = ?`,
      order.amount_fen,
      order.amount_fen,
      userId
    )
    const at = nowIso()
    run(
      db,
      `INSERT INTO wallet_transactions (id, user_id, amount_fen, currency, unit, type, status, entry, request_id, related_id, reason, created_at)
       VALUES (?, ?, ?, 'CNY', 'fen', 'recharge', 'posted', 'recharge', ?, ?, 'test adapter credit; not a real payment', ?)`,
      newId(),
      userId,
      order.amount_fen,
      order.request_id,
      order.id,
      at
    )
    run(db, `UPDATE recharge_orders SET status = 'paid', provider = 'test', paid_at = ? WHERE id = ?`, at, order.id)
    return { orderId: order.id, amountFen: order.amount_fen, credited: true, alreadyPosted: false, realCredit: false, adapter: 'test' }
  })
}

export function freeze(db: DatabaseSync, userId: string, requestId: string, amountFen: number) {
  if (!Number.isSafeInteger(amountFen) || amountFen < 0) throw new HttpError(400, 'invalid_amount', 'Invalid freeze amount')
  if (amountFen === 0) return { frozenFen: 0, idempotent: true }
  return withTx(db, () => {
    const existing = one<{ amount_fen: number }>(
      db,
      `SELECT amount_fen FROM wallet_transactions WHERE request_id = ? AND entry = 'freeze'`,
      requestId
    )
    if (existing) return { frozenFen: Math.abs(existing.amount_fen), idempotent: true }
    const wallet = ownWallet(db, userId)
    if (wallet.available_fen < amountFen) {
      throw new HttpError(402, 'insufficient_balance', '可用余额不足，未调用模型。')
    }
    const changed = run(
      db,
      `UPDATE wallets SET available_fen = available_fen - ?, frozen_fen = frozen_fen + ? WHERE user_id = ? AND available_fen >= ?`,
      amountFen,
      amountFen,
      userId,
      amountFen
    )
    if (!changed) throw new HttpError(402, 'insufficient_balance', '可用余额不足，未调用模型。')
    run(
      db,
      `INSERT INTO wallet_transactions (id, user_id, amount_fen, currency, unit, type, status, entry, request_id, related_id, reason, created_at)
       VALUES (?, ?, ?, 'CNY', 'fen', 'consume', 'reserved', 'freeze', ?, NULL, 'hold before provider call', ?)`,
      newId(),
      userId,
      -amountFen,
      requestId,
      nowIso()
    )
    return { frozenFen: amountFen, idempotent: false }
  })
}

export function releaseHold(db: DatabaseSync, userId: string, requestId: string, reason: string) {
  return withTx(db, () => {
    const prior = one<{ id: string }>(db, `SELECT id FROM wallet_transactions WHERE request_id = ? AND entry = 'failure_reversal'`, requestId)
    if (prior) return { released: false, idempotent: true }
    const hold = one<{ amount_fen: number }>(db, `SELECT amount_fen FROM wallet_transactions WHERE request_id = ? AND entry = 'freeze'`, requestId)
    if (!hold) return { released: false, idempotent: true }
    const settled = one<{ id: string }>(db, `SELECT id FROM wallet_transactions WHERE request_id = ? AND entry = 'settle'`, requestId)
    if (settled) return { released: false, idempotent: true }
    const amount = Math.abs(hold.amount_fen)
    run(
      db,
      `UPDATE wallets SET available_fen = available_fen + ?, frozen_fen = frozen_fen - ? WHERE user_id = ? AND frozen_fen >= ?`,
      amount,
      amount,
      userId,
      amount
    )
    run(
      db,
      `INSERT INTO wallet_transactions (id, user_id, amount_fen, currency, unit, type, status, entry, request_id, related_id, reason, created_at)
       VALUES (?, ?, ?, 'CNY', 'fen', 'failure_reversal', 'posted', 'failure_reversal', ?, NULL, ?, ?)`,
      newId(),
      userId,
      amount,
      requestId,
      reason,
      nowIso()
    )
    return { released: true, idempotent: false }
  })
}

export type ChargeQuote = {
  costFen: number | null
  chargeFen: number | null
  marginFen: number | null
  marginBps: number
  providerCostStatus: 'configured_price_estimate' | 'fixture' | 'unknown'
  note: string
  fxSource: string | null
  fxQuotedAt: string | null
}

export function quoteCharge(
  config: AppConfig,
  margin: number,
  model: string,
  promptTokens: number | null,
  completionTokens: number | null,
  source: 'live' | 'fixture'
): ChargeQuote {
  const mode = billingMode(config)
  const unknown = (note: string): ChargeQuote => ({
    costFen: null,
    chargeFen: null,
    marginFen: null,
    marginBps: margin,
    providerCostStatus: 'unknown',
    note,
    fxSource: null,
    fxQuotedAt: null,
  })
  if (promptTokens === null || completionTokens === null) return unknown('Provider did not report usage. No CNY amount was deducted.')
  const price: ModelPrice | undefined = config.prices[model]
  if (!price || mode === 'off') return unknown('No configured integer price for this model. No CNY amount was deducted.')
  if (mode === 'blocked_fx') {
    return unknown('USD price has no fx source, rate, and timestamp together. No CNY amount was deducted.')
  }
  const minor = tokensToMinor(promptTokens, completionTokens, price.input_per_million, price.output_per_million)
  const costFen = mode === 'cny' ? minor : fenFromMicroUsd(minor, config.fxCnyFenPerUsd!)
  const chargeFen = userChargeFen(costFen, margin)
  const fixture = source === 'fixture'
  return {
    costFen,
    chargeFen,
    marginFen: chargeFen - costFen,
    marginBps: margin,
    providerCostStatus: fixture ? 'fixture' : 'configured_price_estimate',
    note: fixture
      ? 'Fixture-reported usage times the configured price. This is not a DeepSeek bill and not a real model charge.'
      : 'Configured unit price times reported usage. This is an estimate, not a provider invoice.',
    fxSource: mode === 'fx' ? config.fxSource : null,
    fxQuotedAt: mode === 'fx' ? config.fxQuotedAt : null,
  }
}

export function settleQuoted(
  db: DatabaseSync,
  userId: string,
  requestId: string,
  quote: ChargeQuote,
  meta: { model: string; category: 'text' | 'image' | 'voice'; promptTokens: number | null; completionTokens: number | null }
) {
  return withTx(db, () => {
    const existing = one<{ id: string }>(db, `SELECT id FROM model_usage_records WHERE request_id = ?`, requestId)
    if (existing) return { idempotent: true, quote }
    const at = nowIso()
    const hold = one<{ amount_fen: number }>(db, `SELECT amount_fen FROM wallet_transactions WHERE request_id = ? AND entry = 'freeze'`, requestId)
    const held = hold ? Math.abs(hold.amount_fen) : 0
    let status = 'not_billed'
    if (quote.chargeFen !== null && quote.costFen !== null) {
      const extra = Math.max(0, quote.chargeFen - held)
      const wallet = ownWallet(db, userId)
      if (extra > wallet.available_fen) {
        status = 'billing_unknown'
      } else {
        if (extra > 0) {
          const changed = run(
            db,
            `UPDATE wallets SET available_fen = available_fen - ? WHERE user_id = ? AND available_fen >= ?`,
            extra,
            userId,
            extra
          )
          if (!changed) status = 'billing_unknown'
        }
        if (status !== 'billing_unknown') {
          const release = held - quote.chargeFen
          if (held > 0) {
            run(db, `UPDATE wallets SET frozen_fen = frozen_fen - ? WHERE user_id = ? AND frozen_fen >= ?`, held, userId, held)
          }
          if (release > 0) {
            run(db, `UPDATE wallets SET available_fen = available_fen + ? WHERE user_id = ?`, release, userId)
            run(
              db,
              `INSERT INTO wallet_transactions (id, user_id, amount_fen, currency, unit, type, status, entry, request_id, related_id, reason, created_at)
               VALUES (?, ?, ?, 'CNY', 'fen', 'consume', 'released', 'release', ?, NULL, 'unused hold returned', ?)`,
              newId(),
              userId,
              release,
              requestId,
              at
            )
          }
          run(db, `UPDATE wallets SET spent_fen = spent_fen + ? WHERE user_id = ?`, quote.chargeFen, userId)
          run(
            db,
            `INSERT INTO wallet_transactions (id, user_id, amount_fen, currency, unit, type, status, entry, request_id, related_id, reason, created_at)
             VALUES (?, ?, ?, 'CNY', 'fen', 'consume', 'posted', 'settle', ?, NULL, ?, ?)`,
            newId(),
            userId,
            -quote.chargeFen,
            requestId,
            quote.note,
            at
          )
          status = 'settled'
        }
      }
    }
    run(
      db,
      `INSERT INTO model_usage_records (
         id, user_id, request_id, model, category, prompt_tokens, completion_tokens,
         provider_cost_fen, provider_cost_status, provider_currency, fx_source, fx_quoted_at,
         user_charge_fen, margin_fen, margin_bps, status, note, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'CNY', ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId(),
      userId,
      requestId,
      meta.model,
      meta.category,
      meta.promptTokens,
      meta.completionTokens,
      quote.costFen,
      quote.providerCostStatus,
      quote.fxSource,
      quote.fxQuotedAt,
      status === 'settled' ? quote.chargeFen : null,
      status === 'settled' ? quote.marginFen : null,
      quote.marginBps,
      status,
      status === 'billing_unknown' ? `${quote.note} Hold kept because the charge could not be settled. This is not a zero-cost refund.` : quote.note,
      at
    )
    return { idempotent: false, status, quote }
  })
}

export function markBillingUnknown(db: DatabaseSync, userId: string, requestId: string, model: string, note: string) {
  return withTx(db, () => {
    const existing = one<{ id: string }>(db, `SELECT id FROM model_usage_records WHERE request_id = ?`, requestId)
    if (existing) return
    run(
      db,
      `INSERT INTO model_usage_records (
         id, user_id, request_id, model, category, prompt_tokens, completion_tokens,
         provider_cost_fen, provider_cost_status, provider_currency, fx_source, fx_quoted_at,
         user_charge_fen, margin_fen, margin_bps, status, note, created_at
       ) VALUES (?, ?, ?, ?, 'text', NULL, NULL, NULL, 'unknown', 'CNY', NULL, NULL, NULL, NULL, NULL, 'billing_unknown', ?, ?)`,
      newId(),
      userId,
      requestId,
      model,
      note,
      nowIso()
    )
  })
}

export function adjustWallet(
  db: DatabaseSync,
  actorId: string,
  userId: string,
  amountFen: number,
  direction: 'credit' | 'debit',
  reason: string,
  requestId: string
) {
  if (!Number.isSafeInteger(amountFen) || amountFen <= 0) throw new HttpError(400, 'invalid_amount', 'amountFen must be a positive integer')
  if (!reason.trim()) throw new HttpError(400, 'invalid_field', 'reason is required')
  if (!requestId) throw new HttpError(400, 'invalid_field', 'requestId is required')
  return withTx(db, () => {
    const prior = one<{ id: string }>(db, `SELECT id FROM wallet_transactions WHERE request_id = ? AND entry = 'admin_adjust'`, requestId)
    if (prior) return { idempotent: true }
    ownWallet(db, userId)
    const signed = direction === 'credit' ? amountFen : -amountFen
    if (direction === 'debit') {
      const changed = run(
        db,
        `UPDATE wallets SET available_fen = available_fen - ?, spent_fen = spent_fen + ? WHERE user_id = ? AND available_fen >= ?`,
        amountFen,
        amountFen,
        userId,
        amountFen
      )
      if (!changed) throw new HttpError(402, 'insufficient_balance', '余额不足，拒绝把可用余额扣成负数。')
    } else {
      run(db, `UPDATE wallets SET available_fen = available_fen + ? WHERE user_id = ?`, amountFen, userId)
    }
    const at = nowIso()
    run(
      db,
      `INSERT INTO wallet_transactions (id, user_id, amount_fen, currency, unit, type, status, entry, request_id, related_id, reason, created_at)
       VALUES (?, ?, ?, 'CNY', 'fen', 'admin_adjust', 'posted', 'admin_adjust', ?, ?, ?, ?)`,
      newId(),
      userId,
      signed,
      requestId,
      actorId,
      reason.trim(),
      at
    )
    run(
      db,
      `INSERT INTO admin_audit_logs (id, actor_id, action, target_id, reason, request_id, created_at) VALUES (?, ?, 'wallet_adjust', ?, ?, ?, ?)`,
      newId(),
      actorId,
      userId,
      reason.trim(),
      requestId,
      at
    )
    return { idempotent: false, amountFen: signed }
  })
}

export function assertSpendAllowed(db: DatabaseSync, userId: string): void {
  if (gatewayPaused(db)) throw new HttpError(423, 'gateway_paused', '管理员已暂停模型网关。')
  const quota = one<{ daily_budget_fen: number; max_concurrent: number }>(
    db,
    `SELECT daily_budget_fen, max_concurrent FROM quotas WHERE user_id = ?`,
    userId
  )
  if (!quota) return
  if (quota.daily_budget_fen > 0) {
    const start = new Date()
    start.setUTCHours(0, 0, 0, 0)
    const spent = one<{ fen: number }>(
      db,
      `SELECT coalesce(sum(user_charge_fen), 0) AS fen FROM model_usage_records WHERE user_id = ? AND status = 'settled' AND created_at >= ?`,
      userId,
      start.toISOString()
    )
    if ((spent?.fen ?? 0) >= quota.daily_budget_fen) {
      throw new HttpError(429, 'quota_budget', '今日消费额度已用完。')
    }
  }
  if (quota.max_concurrent > 0) {
    const active = one<{ n: number }>(db, `SELECT count(*) AS n FROM messages WHERE user_id = ? AND status = 'streaming'`, userId)
    if ((active?.n ?? 0) >= quota.max_concurrent) throw new HttpError(429, 'quota_concurrency', '并发模型请求已达上限。')
  }
}

export function moneyStats(db: DatabaseSync) {
  const recharge = one<{ fen: number }>(db, `SELECT coalesce(sum(amount_fen), 0) AS fen FROM wallet_transactions WHERE type = 'recharge' AND status = 'posted'`)
  const charges = one<{ fen: number }>(
    db,
    `SELECT coalesce(sum(user_charge_fen), 0) AS fen FROM model_usage_records WHERE status = 'settled' AND provider_cost_status != 'fixture'`
  )
  const fixtureCharges = one<{ fen: number }>(
    db,
    `SELECT coalesce(sum(user_charge_fen), 0) AS fen FROM model_usage_records WHERE status = 'settled' AND provider_cost_status = 'fixture'`
  )
  const knownCost = one<{ fen: number }>(
    db,
    `SELECT coalesce(sum(provider_cost_fen), 0) AS fen FROM model_usage_records WHERE status = 'settled' AND provider_cost_status = 'configured_price_estimate'`
  )
  const unknownRows = one<{ n: number }>(db, `SELECT count(*) AS n FROM model_usage_records WHERE provider_cost_status = 'unknown' OR status = 'billing_unknown'`)
  return {
    prepaidRechargeFen: recharge?.fen ?? 0,
    prepaidRechargeDisplay: formatFen(recharge?.fen ?? 0),
    estimatedServiceChargeFen: charges?.fen ?? 0,
    fixtureChargeFen: fixtureCharges?.fen ?? 0,
    estimatedProviderCostFen: knownCost?.fen ?? 0,
    estimatedMarginFen: (charges?.fen ?? 0) - (knownCost?.fen ?? 0),
    unknownCostRows: unknownRows?.n ?? 0,
    note: '充值是预收权益，不是服务收入。夹具扣费不是真实模型消费。没有供应商账单时，成本只是配置单价估算或未知。',
  }
}
