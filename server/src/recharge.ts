import { many } from './db.ts'
import { asString, HttpError, json, readJson, requireAdmin, requireUser } from './http.ts'
import type { Route } from './http.ts'
import {
  billingDisclosure,
  cancelRecharge,
  confirmRecharge,
  createRechargeOrder,
  disableQr,
  listLedger,
  listOwnOrders,
  listUsage,
  orderJson,
  presetsJson,
  qrBytes,
  qrStatus,
  readWallet,
  rejectRecharge,
  saveQr,
  submitUserReference,
  walletJson,
  type RechargeOrderRow,
} from './wallet.ts'

function amountFen(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new HttpError(400, 'invalid_amount', 'amountFen 必须是服务端档位里的整数分。')
  }
  return value
}

export function registerRechargeRoutes(add: (method: string, pathname: string, handler: Route['handler']) => void) {
  add('GET', '/api/wallet', async (ctx) => {
    const user = requireUser(ctx)
    const wallet = await readWallet(ctx.db, user.id)
    const orders = await listOwnOrders(ctx.db, user.id)
    const ledger = await listLedger(ctx.db, user.id)
    const usage = await listUsage(ctx.db, user.id)
    json(ctx.res, 200, {
      wallet: walletJson(wallet),
      billing: billingDisclosure(ctx.config),
      qr: await qrStatus(ctx.db),
      presets: presetsJson(),
      orders: orders.map((order) => orderJson(order)),
      ledger: ledger.map((row) => ({
        id: row.id,
        entry: row.entry,
        amountFen: row.amount_fen,
        note: row.note,
        createdAt: row.created_at,
      })),
      usage: usage.map((row) => ({
        id: row.id,
        kind: row.kind,
        model: row.model,
        promptTokens: row.prompt_tokens,
        completionTokens: row.completion_tokens,
        costFen: row.cost_fen,
        chargeFen: row.charge_fen,
        status: row.status,
        source: row.source,
        note: row.note,
        createdAt: row.created_at,
      })),
      boundaries: {
        emailRecovery: false,
        automaticAlipay: false,
        note: '没有账号找回，也没有支付宝自动回调。未审核、拒绝和取消都不会加余额。',
      },
    })
  })

  add('GET', '/api/recharge/qr', async (ctx) => {
    requireUser(ctx)
    const image = await qrBytes(ctx.db)
    if (!image) throw new HttpError(404, 'qr_not_configured', '支付宝收款还没有开通。')
    ctx.res.writeHead(200, {
      'Content-Type': image.mime,
      'Content-Length': image.bytes.length,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    ctx.res.end(image.bytes)
  })

  add('POST', '/api/recharge/orders', async (ctx) => {
    const user = requireUser(ctx)
    const body = await readJson(ctx.req)
    const order = await createRechargeOrder(ctx.db, user.id, amountFen(body.amountFen), asString(body.requestId, 'requestId', 8, 80))
    const wallet = await readWallet(ctx.db, user.id)
    json(ctx.res, 200, {
      order: orderJson(order),
      wallet: walletJson(wallet),
      credited: false,
      note: '这是充值申请，不是到账。提交付款参考或截图都不会加余额，需要管理员对照支付宝账单后另行确认。',
    })
  })

  add('POST', '/api/recharge/orders/:id/reference', async (ctx) => {
    const user = requireUser(ctx)
    const body = await readJson(ctx.req)
    const order = await submitUserReference(ctx.db, user.id, ctx.params.id, asString(body.reference, 'reference', 6, 64))
    const wallet = await readWallet(ctx.db, user.id)
    json(ctx.res, 200, {
      order: orderJson(order),
      wallet: walletJson(wallet),
      credited: false,
      note: '付款参考已记下，状态仍是待核实，余额没有增加。',
    })
  })

  add('POST', '/api/recharge/orders/:id/cancel', async (ctx) => {
    const user = requireUser(ctx)
    const order = await cancelRecharge(ctx.db, user.id, ctx.params.id)
    const wallet = await readWallet(ctx.db, user.id)
    json(ctx.res, 200, {
      order: orderJson(order),
      wallet: walletJson(wallet),
      credited: false,
      note: '申请已取消，没有加余额。',
    })
  })

  add('POST', '/api/admin/recharge/qr', async (ctx) => {
    const admin = requireAdmin(ctx)
    const body = await readJson(ctx.req)
    if (typeof body.imageBase64 !== 'string') throw new HttpError(400, 'invalid_qr', '需要 imageBase64。')
    const saved = await saveQr(ctx.db, admin.id, body.imageBase64)
    json(ctx.res, 200, { enabled: true, mime: saved.mime, bytes: saved.bytes })
  })

  add('POST', '/api/admin/recharge/qr/disable', async (ctx) => {
    const admin = requireAdmin(ctx)
    await disableQr(ctx.db, admin.id)
    json(ctx.res, 200, { enabled: false })
  })

  add('GET', '/api/admin/recharge/orders', async (ctx) => {
    requireAdmin(ctx)
    const rows = await many<RechargeOrderRow & { email: string }>(
      ctx.db,
      `SELECT o.*, u.email AS email
       FROM recharge_orders o JOIN users u ON u.id = o.user_id
       WHERE o.status IN ('pending', 'submitted', 'paid', 'rejected', 'cancelled')
       ORDER BY o.created_at DESC LIMIT 100`
    )
    json(ctx.res, 200, {
      orders: rows.map((row) => orderJson(row, row.email)),
      note: '用户填写的参考不是到账凭证。入账只发生在明确确认之后。',
    })
  })

  add('POST', '/api/admin/recharge/orders/:id/confirm', async (ctx) => {
    const admin = requireAdmin(ctx)
    const body = await readJson(ctx.req)
    if (body.acknowledged !== true) {
      throw new HttpError(400, 'confirmation_required', '确认入账需要 acknowledged=true。这是第二次明确操作。')
    }
    const result = await confirmRecharge(ctx.db, admin.id, ctx.params.id, {
      paymentReference: asString(body.paymentReference, 'paymentReference', 6, 64),
      note: asString(body.note, 'note', 1, 200),
      acknowledged: true,
    })
    const wallet = await readWallet(ctx.db, result.order.user_id)
    json(ctx.res, 200, {
      order: orderJson(result.order),
      wallet: walletJson(wallet),
      credited: result.credited,
      note: result.credited ? '已按订单金额入账。这不是支付宝自动到账。' : '这笔申请已经入过账，没有再次加余额。',
    })
  })

  add('POST', '/api/admin/recharge/orders/:id/reject', async (ctx) => {
    const admin = requireAdmin(ctx)
    const body = await readJson(ctx.req)
    if (body.acknowledged !== true) {
      throw new HttpError(400, 'confirmation_required', '拒绝需要 acknowledged=true。拒绝不会加余额。')
    }
    const order = await rejectRecharge(ctx.db, admin.id, ctx.params.id, {
      note: asString(body.note, 'note', 1, 200),
      acknowledged: true,
    })
    const wallet = await readWallet(ctx.db, order.user_id)
    json(ctx.res, 200, {
      order: orderJson(order),
      wallet: walletJson(wallet),
      credited: false,
      note: '已拒绝，没有加余额。',
    })
  })

  add('GET', '/api/admin/audit', async (ctx) => {
    requireAdmin(ctx)
    const rows = await many<{ id: string; actor_id: string; action: string; target_id: string; note: string; created_at: string }>(
      ctx.db,
      `SELECT id, actor_id, action, target_id, note, created_at FROM admin_audit_logs ORDER BY created_at DESC LIMIT 100`
    )
    json(ctx.res, 200, { audits: rows })
  })
}
