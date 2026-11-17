# Deep Companion

产品标识是文字「D/」。这不是 DeepSeek 官方应用。

人手测请看 [docs/TRIAL.md](docs/TRIAL.md)。复用和未复用的项目见 [docs/REUSE.md](docs/REUSE.md)。

邀请制的陪伴与工作区服务。普通用户购买和使用的是服务，不在浏览器里配置供应商 API Key。模型请求只从服务端的 DeepSeek 兼容网关发出。

人格卡和记忆分开存储。新建角色时可以选两张标成「示例」的内置模板（工作助手、日常陪伴），选中后仍是你自己的角色，可以改、可以复制。没有模板市场。人格卡可以导出再导入；记忆包不能写进人格卡。每个账号最多 5 个 Companion，创建、复制和导入共用这个限额，删除后释放。

记忆可以按 JSON、JSONL、Markdown、TXT 或本产品 Memory Package 预览、分类、去重，确认后才写入指定角色。导出的记忆包能导回去，并保留来源、时间和是否明确。ChatGPT、Gemini、DeepSeek 历史适配器还没有实现。

Workspace 与 Companion 的会话、附件和检索权限分开。陪伴默认不能读取工作区记录；用户授权具体字段后只能只读，读取会记审计，授权可以撤销。

## 上游

先核对了 DeepSeek 2026-11-13 的官方发布和 https://github.com/deepseek-ai/chat-demo 。那次发布是应用 API 和一份 MIT 前端演示，不是 App 权重。演示本身要求用户在浏览器填写 Key，所以没有把它当作产品外壳。Markdown、代码高亮、公式和 Mermaid 渲染复用了固定 commit `5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c`。细节见 [docs/UPSTREAM.md](docs/UPSTREAM.md) 和 [NOTICE](NOTICE)。

## 运行

需要 Node.js 22。

```sh
npm install
npm run migrate
ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='choose-a-long-password' npm run admin:init
npm run build
npm start
```

管理员初始化只从环境变量读密码，不会把密码写进仓库。邀请码：

```sh
npm run admin:invite -- --count 10
```

明文邀请码只在创建时输出一次。首批建议 10 到 20 个。

配置示例在 `.env.example`。里面没有密钥。`DEEPSEEK_API_KEY` 由管理员在服务端环境里设置。没有这把 Key、且模式为 `live` 时，聊天返回 `model_gateway_unconfigured`，不会生成假回复。

`MODEL_GATEWAY_MODE=fixture` 只给测试使用，必须同时设置 `ALLOW_GATEWAY_FIXTURE=1`，并且在 `NODE_ENV=production` 时直接拒绝启动。夹具回复不是 DeepSeek 输出。

开发时可以另开 `npm run dev:web`，Vite 把 `/api` 代理到 `127.0.0.1:8787`。

## 测试

```sh
npm test
npm run build
npm run e2e
```

`npm test` 覆盖注册登录、邀请码并发消费、跨账号隔离、两空间权限、网关失败与流式、Key 不出现在响应和日志、额度、时间线授权撤销审计、主动消息去重和上限，以及数据库文件重启后的数据保留。`npm run e2e` 用系统 Chrome 走真实页面：邀请、注册、人格、记忆、流式聊天、退出再登录。没有供应商 Key 时，真实模型这一项不能算通过。

## 数据

SQLite 文件默认在 `data/app.sqlite`。表结构由 `server/migrations/001_init.sql` 在启动和 `npm run migrate` 时应用。上传文件在 `DATA_DIR/blobs/<userId>/`，下载时校验所有权。

## 主动消息

服务端可以定时调用 `INITIATIVE_POLL_MS`，也可以由已登录用户调用 `POST /api/initiative/tick`。这不是手机后台。已经实现的触发只有「一条已授权的时间线事件生成一条应用内消息」，带开关、免打扰、每日上限、幂等键和每次有限次模型调用。定时、工作事件、历史跟进、日期提醒会明确返回未实现，不会假装已经做好。

## 还没有做

- 没有供应商 Key 时的真实 DeepSeek 对话。协议链路只用测试夹具验证过。
- ChatGPT、Gemini、DeepSeek 历史迁移适配器。DeepSeek ZIP 会明确拒绝。
- 官方演示里的语音、联网搜索、链接阅读。
- 支付、订阅、多供应商、生图、长期记忆压缩和角色演化。
- 手机推送。响应式 Web 已在 390px 宽的浏览器里走过主路径。此环境没有 Android SDK，也没有 macOS/Xcode，所以没有 APK 或 iOS 构建。以后可以再加 Capacitor，但现在没有移动包。

验收对照见 [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)。
