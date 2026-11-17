# 免费部署准备

这是 Render 免费 Web 服务加上外部 Postgres 的准备，不是已经上线的网站。仓库里没有公网地址，也没有创建 Render 或 Neon 资源。

## 运行形态

- 生产必须有 `DATABASE_URL`，并且只能是 `postgres://` 或 `postgresql://`。没有它时进程拒绝启动，避免把用户数据写进免费实例的临时磁盘。
- 本机不设置 `DATABASE_URL` 时仍使用 SQLite，手测路径不变。
- `COOKIE_SECURE` 在生产默认开启。`HOST` 默认 `0.0.0.0`，端口用平台的 `PORT`。
- 页面和 `/api` 由同一个 Node 进程提供。反向代理终止 HTTPS。请求里如果带了 `Origin`，主机必须和 `Host` 一致，不会信任任意来源。
- 没有公开的管理员初始化接口。第一次管理员仍用 `npm run admin:init`，邀请码用 `npm run admin:invite`。
- `DATABASE_URL` 和 `DEEPSEEK_API_KEY` 只放服务端环境。日志会把连接串和 `sk-` 打成 `[redacted]`。

## 免费档明确不做的事

- 附件和摘录在 Postgres 模式下返回 `uploads_disabled`。不把文件写到实例磁盘。对象存储还没核实，所以不假装可用。
- `INITIATIVE_POLL_MS` 在生产必须是 `0`。免费实例会休眠，不能承诺定时主动消息。已登录用户仍可以手动检查已授权的时间线。
- `render.yaml` 只有一个免费 Web 服务。没有 Render 数据库、磁盘或定时任务。

## 内测 App

可分发安装包要从 `COMPANION_PUBLIC_ORIGIN` 锁定真实 HTTPS 源。没有这个域名时 `npm run android:trial` 退出状态 `BLOCKED`，不生成安装包。debug 地址选择器只留在开发变体里，不是内测交付。原来的 debug APK 只作为开发证据。

真实域名由父助手创建后再填进构建配置。不要把示例地址写进成品。

## 还没发生的事

- 没有把这个服务部署到 Render。
- 没有 Neon 连接串，也没有导入任何现有数据库。
- 没有供应商 Key，真实模型请求没有通过。夹具回复以 `fixture-reply:` 开头，不能当成 DeepSeek。
- 没有在手机或模拟器上安装运行。
