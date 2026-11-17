# 账户与钱包

交互检查点 `07ec01ebd59b2e5da026b5d30582baf4f1caa11b` 和 `docs/evidence/companion-platform-trial-logs.zip` 保持原样。这一页描述检查点之后的账户实现。没有公开地址，不合并 `main`，不部署。

## 启动

需要 Node.js 22，以及至少 32 位的 `BETTER_AUTH_SECRET`。示例文件 `.env.example` 只有空位，没有密钥。

```sh
export BETTER_AUTH_SECRET="$(openssl rand -base64 32)"
npm install
npm run migrate
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='choose-a-long-password' npm run admin:init
npm run admin:invite -- --count 10
npm run build
npm start
```

管理员只能由本机 CLI 创建。`POST /api/admin/init` 仍是 404。密码不会打印。

已有用户在 `003_accounts_wallet.sql` 里保留原来的 `users.id` 和 `role`。旧的 `scrypt$` 密码复制到 `auth_account`，登录时只做校验桥接。新密码由 Better Auth 哈希。旧的手写 `sessions` 令牌不迁移，需要重新登录。注册成功后钱包可用余额是 0 分。

## 表

迁移文件：`server/migrations/003_accounts_wallet.sql`。

- `users`：原表重建，补 `email_verified`、`image`、`banned`、`banReason`、`banExpires`。`password_hash` 改为可空。
- `auth_session`、`auth_account`、`auth_verification`：Better Auth 的会话、密码和令牌。
- `user_profiles`：用户名、状态、等级。
- `wallets`：可用、冻结、累计充值、累计消费、累计退款，单位全是整数分。
- `wallet_transactions`：只追加。`request_id + entry` 唯一。
- `recharge_orders`：`pending`、`paid`、`cancelled`。
- `model_usage_records`：供应商成本、用户扣费和毛利分开。
- `user_model_permissions`、`admin_audit_logs`、`mail_outbox`、`app_settings`。
- `admin_users`：只读视图，来自 `users.role = 'admin'`，不是第二套角色表。
- `quotas` 增加 `daily_budget_fen` 和 `max_concurrent`。0 表示不限制。

## 接口

金额字段同时给整数分和 `formatFen` 文本。500 分显示 `5.00`。

- `POST /api/register`：邀请码、次数、过期、撤销。并发消费不会超过 `max_uses`。
- `POST /api/login`、`POST /api/logout`：Cookie 名仍是 `cp_session`，由 Better Auth 签发。
- `POST /api/account/password`：修改密码。
- `POST /api/account/password/forgot`：没有邮件传输时 503 `mail_transport_unconfigured`，明确没有发出邮件。
- `POST /api/account/password/reset`、`POST /api/account/email/verify`：只接受夹具信箱里的令牌。
- `GET /api/test/mailbox`：仅 `ALLOW_MAIL_FIXTURE=1` 且非生产。响应 `realDelivery: false`。
- `GET /api/account/sessions`、`POST /api/account/sessions/:id/revoke`。
- `GET /api/wallet`：只返回当前用户。
- `POST /api/wallet/recharge`：只接受 500、1000、2000、5000、10000 分。创建 `pending` 订单，不加余额，`realPayment: false`。
- `POST /api/wallet/recharge/:id/test-confirm`：仅 `ALLOW_TEST_PAYMENTS=1`。按该订单金额入账一次。`realCredit: false`，`adapter: "test"`。
- `POST /api/images`：501 `image_generation_not_implemented`。
- `GET /api/admin/users`、停用和恢复、`POST /api/admin/wallet/adjust`、`GET /api/admin/ledger`、`GET /api/admin/money`、`POST /api/admin/gateway`。普通用户 403。

目标毛利默认 30%（`margin_bps = 3000`）。用户扣费 = `ceil(成本分 * 10000 / (10000 - margin_bps))`。成本 70 分时扣费 100 分，500 分余额变成 400 分，显示从 `5.00` 变为 `4.00`。充值记账是预收权益，不是服务收入。没有供应商账单时，成本状态是 `configured_price_estimate`、`fixture` 或 `unknown`，不会写成真实发票。USD 价格缺少汇率、来源和时间三者之一时不扣人民币。

夹具扣费的 `providerCostStatus` 是 `fixture`，`realUpstreamCharge` 是 false。它不是真实模型消费。

主动消息在钱包计价打开时会跳过，原因 `initiative_billing_not_settled`，避免未冻结就调用模型。计价关闭时，原有的已授权时间线触发仍可用。

## 完成、部分、未完成

完成：单一 Better Auth 身份、旧用户和角色迁移、邀请次数/过期/撤销/并发、设备会话、资料和管理员停用、登录限流、整数分钱包、测试适配器入账、冻结/结算/失败释放、请求号幂等、并发不出现负余额、默认 30% 毛利、个人中心、深浅色、跨用户拒绝。

部分：邮件验证和重置只在显式本地夹具里跑通。真实 SMTP 未配置，接口按未发出处理。网关扣费使用配置单价，不是上游账单。主动消息还没有自己的冻结结算，计价打开时会拒绝调用。

未完成：真实支付、真实到账、真实邮件、真实 DeepSeek 消费、生图、语音、外部历史适配器，以及其他主动触发。真实模型对话仍然 BLOCKED。
