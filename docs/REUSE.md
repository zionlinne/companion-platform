# 复用清单

这份清单只写已经核对过、并且真正接进当前代码的项目。Markdown 渲染复用不是整个产品的复用。交互检查点 `07ec01ebd59b2e5da026b5d30582baf4f1caa11b` 里的认证仍是自写的；那次提交没有安装 Better Auth。当前分支在该检查点之后只保留 Better Auth 这一套密码和会话。

## 已经复用

| 项目 | 固定版本 | 许可证 | 用了什么 | 我们的改动 |
| --- | --- | --- | --- | --- |
| https://github.com/deepseek-ai/chat-demo | commit `5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c`（2026-11-13，v0.1.1） | MIT，Copyright (c) 2026 DeepSeek。全文在 `web/src/vendor/deepseek-chat-demo/LICENSE` | Markdown、Prism 代码高亮、KaTeX、Mermaid。文件列表在同目录 `NOTICE.md` | 只改了 `CodeBlock.tsx` 的语法缺失保护。为了编译写了主题、提示和引用垫片。没有复制它的 API Key 设置、IndexedDB 和直接请求供应商的客户端 |
| https://github.com/better-auth/better-auth | npm `better-auth@1.4.18`，登记时间 2026-11-15。文档 https://www.better-auth.com/docs/adapters/sqlite | MIT | 邮箱密码、scrypt 哈希、`cp_session` Cookie、会话列表和撤销、改密、重置和验证令牌。用户表映射到现有 `users`，会话在 `auth_session`，密码在 `auth_account`。管理角色用官方 admin 插件的 `users.role`，`admin_users` 是只读视图 | 邀请码、¥0 钱包和邮件夹具是产品规则，库里没有。旧 `scrypt$` 哈希只在校验时桥接，新密码只走 Better Auth。没有再发一套 `sessions` 令牌 |

React、Vite 和 Playwright 是运行和测试用的依赖，不是把某个聊天产品接进来。

## 查过但没有采用

| 候选 | 核对结果 | 为什么不换 |
| --- | --- | --- |
| [Lucia](https://github.com/pilcrowOnPaper/lucia) 3.2.2，MIT | npm 标记 deprecated，指向 https://lucia-auth.com/lucia-v3/migrate ，包更新停在 2025-06-06 | 不采用已停止维护的认证库 |
| [Oslo](https://github.com/pilcrowOnPaper/oslo) 1.2.1，MIT | npm 标记 no longer supported，指向 https://oslojs.dev | 它是底层零件，不是完整的邮箱会话产品。Better Auth 已经提供密码哈希 |
| 真实 SMTP 库 | 当前环境没有可用的发信账号 | 不安装一个未配置的发信器来假装邮件已发出。未配置时接口返回 `mail_transport_unconfigured`。测试只在 `ALLOW_MAIL_FIXTURE=1` 时写入本地 `mail_outbox` |
| 真实支付 SDK | 没有获准的支付商户 | 不接入。用户下单保持 `pending` 且不加余额。测试入账只在 `ALLOW_TEST_PAYMENTS=1` 时确认指定订单 |

DeepSeek 公开文档有调用参数 `user_id`，用来做内容安全和缓存隔离：https://api-docs.deepseek.com/quick_start/rate_limit 。没有查到可授权的 Token Management API。公开的密钥页面是控制台 https://platform.deepseek.com/api_keys/apiKey ，不是给服务端代管用户密钥的接口。因此不自造管理接口，也不把供应商 Key 交到浏览器。

## 仍自写的部分

邀请码次数、过期和撤销，Workspace 和 Companion 的隔离，5 个 Companion 名额，时间线字段授权，主动消息，记忆包，整数分钱包、冻结结算和毛利计算是产品规则。上面这些库没有对应实现。聊天页面、路由和账本表也是自写的，因为 chat-demo 把 Key 放在浏览器里，不能当作产品外壳。旧的 `usage_ledger` 仍是 token 计数，不是金额账本。
