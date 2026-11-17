import { useEffect, useState, type FormEvent } from 'react'
import { ApiError, api } from '../api.ts'
import { useSession } from '../session.tsx'

type WalletPayload = {
  wallet: { availableFen: number; frozenFen: number; availableYuan: string; rechargeFen: number; spentFen: number }
  billing: { state: 'off' | 'unpriced' | 'ready'; marginBps: number; note: string }
  qr: { enabled: boolean }
  presets: Array<{ amountFen: number; amountYuan: string }>
  orders: Order[]
  ledger: Array<{ id: string; entry: string; amountFen: number; note: string; createdAt: string }>
  usage: Array<{ id: string; kind: string; model: string; chargeFen: number | null; status: string; source: string; note: string }>
  boundaries: { emailRecovery: boolean; automaticAlipay: boolean; note: string }
}

type Order = {
  id: string
  email?: string
  amountFen: number
  amountYuan: string
  status: 'pending' | 'submitted' | 'paid' | 'rejected' | 'cancelled'
  userReference: string | null
  paymentReference: string | null
  reviewNote: string | null
}

const statusLabel: Record<Order['status'], string> = {
  pending: '充值申请',
  submitted: '待核实',
  paid: '管理员已确认到账',
  rejected: '已拒绝，未入账',
  cancelled: '已取消，未入账',
}

export function RechargePage() {
  const { user } = useSession()
  const [data, setData] = useState<WalletPayload | null>(null)
  const [message, setMessage] = useState('')
  const [reference, setReference] = useState<Record<string, string>>({})
  const [adminOrders, setAdminOrders] = useState<Order[]>([])
  const [review, setReview] = useState<Record<string, { reference: string; note: string; acknowledged: boolean }>>({})

  async function load() {
    const payload = await api<WalletPayload>('/api/wallet')
    setData(payload)
    if (user?.role === 'admin') {
      const reviewList = await api<{ orders: Order[] }>('/api/admin/recharge/orders')
      setAdminOrders(reviewList.orders)
    }
  }

  useEffect(() => {
    void load().catch((error: unknown) => setMessage(error instanceof ApiError ? error.message : '充值页加载失败'))
  }, [user?.role])

  async function createOrder(amountFen: number) {
    setMessage('')
    const created = await api<{ note: string; credited: boolean }>('/api/recharge/orders', {
      body: { amountFen, requestId: `web${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}` },
    })
    setMessage(created.credited ? '返回异常：申请不应该入账。' : created.note)
    await load()
  }

  async function submitReference(orderId: string) {
    setMessage('')
    const result = await api<{ note: string; credited: boolean }>(`/api/recharge/orders/${orderId}/reference`, {
      body: { reference: reference[orderId] ?? '' },
    })
    setMessage(result.credited ? '返回异常：提交参考不应该入账。' : result.note)
    await load()
  }

  async function cancel(orderId: string) {
    const result = await api<{ note: string }>(`/api/recharge/orders/${orderId}/cancel`, { body: {} })
    setMessage(result.note)
    await load()
  }

  async function uploadQr(file: File) {
    const imageBase64 = await fileToBase64(file)
    await api('/api/admin/recharge/qr', { body: { imageBase64 } })
    setMessage('收款码已保存。用户仍要等管理员核对账单后才会入账。')
    await load()
  }

  async function disableQr() {
    await api('/api/admin/recharge/qr/disable', { body: {} })
    setMessage('收款码已停用。未配置时不会显示成可以付款。')
    await load()
  }

  async function decide(orderId: string, action: 'confirm' | 'reject') {
    const row = review[orderId] ?? { reference: '', note: '', acknowledged: false }
    const path = action === 'confirm' ? 'confirm' : 'reject'
    const result = await api<{ note: string; credited: boolean }>(`/api/admin/recharge/orders/${orderId}/${path}`, {
      body: {
        paymentReference: row.reference,
        note: row.note,
        acknowledged: row.acknowledged,
      },
    })
    setMessage(result.note)
    await load()
  }

  if (!data) return <main className="page"><p>{message || '正在读取充值账户'}</p></main>

  return (
    <main className="page recharge">
      <header className="page-head">
        <div>
          <p className="eyebrow">账户</p>
          <h1>充值申请</h1>
        </div>
      </header>
      <section className="panel">
        <p>可用余额 {data.wallet.availableYuan} 元</p>
        <p className="muted">冻结 {data.wallet.frozenFen} 分 · 累计确认入账 {data.wallet.rechargeFen} 分 · 已结算消费 {data.wallet.spentFen} 分</p>
        <p data-testid="billing-note">{data.billing.note}</p>
      </section>
      {data.qr.enabled ? (
        <section className="panel" data-testid="recharge-open">
          <h2>支付宝收款码</h2>
          <img className="qr-frame" alt="管理员配置的支付宝收款码" src="/api/recharge/qr" />
          <p>扫码后仍是充值申请，需人工确认到账。页面不会把“已付款”写成已到账。</p>
          <div className="row">
            {data.presets.map((preset) => (
              <button key={preset.amountFen} className="primary" type="button" onClick={() => void createOrder(preset.amountFen)}>
                {preset.amountYuan} 元
              </button>
            ))}
          </div>
        </section>
      ) : (
        <section className="panel recharge-closed" data-testid="recharge-closed">
          <h2>未开通</h2>
          <p>支付宝收款还没有开通。管理员还没有配置收款码，现在不能创建充值申请，也不能付款。</p>
          <div className="row">
            {data.presets.map((preset) => (
              <button key={preset.amountFen} type="button" disabled>
                {preset.amountYuan} 元
              </button>
            ))}
          </div>
        </section>
      )}
      <section className="panel">
        <h2>我的申请</h2>
        {data.orders.length === 0 ? <p className="muted">还没有充值申请。</p> : null}
        {data.orders.map((order) => (
          <article key={order.id} className="order" data-testid={`order-${order.status}`}>
            <p>{statusLabel[order.status]} · {order.amountYuan} 元</p>
            <p className="muted">单号 {order.id}</p>
            {order.status === 'pending' || order.status === 'submitted' ? (
              <form onSubmit={(event: FormEvent) => { event.preventDefault(); void submitReference(order.id) }}>
                <label>付款参考（只作对照，不会入账）
                  <input value={reference[order.id] ?? ''} onChange={(event) => setReference({ ...reference, [order.id]: event.target.value })} />
                </label>
                <div className="row">
                  <button className="ghost" type="submit">提交待核实</button>
                  <button className="ghost" type="button" onClick={() => void cancel(order.id)}>取消申请</button>
                </div>
              </form>
            ) : null}
            {order.paymentReference ? <p>入账流水 {order.paymentReference}</p> : null}
          </article>
        ))}
      </section>
      <section className="panel">
        <h2>余额和消费</h2>
        {data.ledger.length === 0 ? <p className="muted">还没有入账或扣费。</p> : null}
        {data.ledger.map((row) => (
          <p key={row.id}>{row.entry} {row.amountFen} 分 · {row.note}</p>
        ))}
        {data.usage.map((row) => (
          <p key={row.id}>{row.kind} {row.model} · {row.status} · {row.chargeFen ?? 0} 分 · {row.note}</p>
        ))}
      </section>
      {user?.role === 'admin' ? (
        <section className="panel" data-testid="recharge-admin">
          <h2>管理员核对</h2>
          <p>先看真实支付宝账单，再单独确认。确认不会读取支付宝密码或商户私钥。</p>
          <label className="file-row">上传收款码
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void uploadQr(file).catch((error: unknown) => setMessage(error instanceof ApiError ? error.message : '上传失败'))
              }}
            />
          </label>
          <button className="ghost" type="button" onClick={() => void disableQr()}>停用收款码</button>
          {adminOrders.filter((order) => order.status === 'pending' || order.status === 'submitted').map((order) => {
            const row = review[order.id] ?? { reference: '', note: '', acknowledged: false }
            return (
              <article key={order.id} className="order">
                <p>{order.email} · {order.amountYuan} 元 · {statusLabel[order.status]}</p>
                <p className="muted">单号 {order.id} · 用户参考 {order.userReference ?? '无'}，不能当作到账</p>
                <label>账单流水
                  <input value={row.reference} onChange={(event) => setReview({ ...review, [order.id]: { ...row, reference: event.target.value } })} />
                </label>
                <label>审核说明
                  <input value={row.note} onChange={(event) => setReview({ ...review, [order.id]: { ...row, note: event.target.value } })} />
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={row.acknowledged}
                    onChange={(event) => setReview({ ...review, [order.id]: { ...row, acknowledged: event.target.checked } })}
                  />
                  我已核对支付宝账单，这是另一次明确操作
                </label>
                <div className="row">
                  <button className="primary" type="button" disabled={!row.acknowledged || !row.reference || !row.note} onClick={() => void decide(order.id, 'confirm')}>确认到账并入账</button>
                  <button className="ghost" type="button" disabled={!row.acknowledged || !row.note} onClick={() => void decide(order.id, 'reject')}>拒绝，不加余额</button>
                </div>
              </article>
            )
          })}
        </section>
      ) : null}
      <p className="muted" data-testid="account-boundary">{data.boundaries.note}</p>
      {message ? <p role="status">{message}</p> : null}
    </main>
  )
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('read failed'))
    reader.readAsDataURL(file)
  })
}
