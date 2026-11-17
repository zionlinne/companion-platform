# 验收矩阵

日期：2026-11-17。状态只描述已经跑过的代码，不把测试夹具说成真实 DeepSeek。

服务端测试和浏览器端到端都在本分支跑过。浏览器聊天走的是显式夹具，横幅写明不是 DeepSeek。没有供应商 Key，所以「真实角色聊天」仍然是 BLOCKED，不能写成通过。每个账号最多 5 个 Companion，创建、复制和导入在同一个写事务里计数。人手测步骤在 `docs/TRIAL.md`，截图在 `docs/evidence/screenshots/`。账户、钱包和 Better Auth 替换不在这份检查点里。

## 长期记忆

2026-11-17，在 `3cdde333c9addafb718080603f6770dda9b3fc63` 之上增量加入。人格卡仍是 `characters`。连续记忆仍是 `memories`，用 `003_memory_engine.sql` 扩状态并复制旧行。模型提取走原来的 `streamCompletion`。测试里的模型输出是标明的 stub，不是 DeepSeek。没有供应商 Key，所以真实模型提取没有测。

聊天先把回复写完。提取在回复之后、同一进程里进行。写失败、坏 JSON 和超时不会把已经完成的聊天改成失败。同一条消息最多尝试 3 次。免费托管休眠或重启可能丢掉还没写完的提取，这不是可靠队列。

| # | 项 | 结果 |
| --- | --- | --- |
| 1 | 明确要求保存 | 通过。`请记住` 写入 `user_requested`，`长期偏好` 写入 `user_stated`。不因后续空提取而失效。 |
| 2 | 普通对话的长期价值 | 通过，stub。普通句子在空 stub 下不落库。stub 返回的习惯写入 `model_inferred`，不能把来源改成用户原话。 |
| 3 | 自然纠错 | 通过。用户「更正」和 stub 的 `fact_changed` 都会定位旧行。 |
| 4 | 新值替换当前 | 通过。旧行 `expired` 或 `superseded`，新行 `active`。 |
| 5 | 历史追溯 | 通过。旧 `content` 和 `created_at` 还在，`superseded_by` 指向新行。`GET ?status=trace` 能读到。 |
| 6 | 新会话召回 | 通过。新会话只注入和当前话题重叠的 active 记忆。 |
| 7 | 人格跨会话 | 通过。人格卡字段在多次会话后不变，并单独放在 `[Persona]`。 |
| 8 | 普通聊天不改人格 | 通过。stub 里的 `category: persona` 被丢弃，角色行不更新。 |
| 9 | 无关记忆不污染 | 通过。排序代码的提示词不含猫和茶。下雨的提示词不含游泳。 |
| 10 | 跨用户隔离 | 通过。另一个账号读记忆得到 404。 |

另外：另一个角色和 Workspace 读不到这条陪伴记忆；并发纠错只留下一条当前记录；重复键不插第二条；坏 JSON、30ms 超时、写库失败都不抛到聊天；SQLite 和 Postgres 都先保留旧行再跑 003。低置信度不会覆盖用户明确记忆。目标有两条同样匹配时不覆盖。主动提醒提示词仍只有授权时间线字段。

`npm test` 39 项通过。`npm run typecheck`、`npm run build`、`npm run e2e`、`npm run e2e:mobile` 通过。浏览器端到端用的是夹具，不是真实模型。

真实供应商对话这一项是 **BLOCKED**：没有获准使用的 `DEEPSEEK_API_KEY`，也没有搜索或使用任何旧密钥。`live` 模式在没有 Key 时返回 `model_gateway_unconfigured`，不插入假回复。夹具模式必须显式打开，回复带 `fixture-reply:` 或 `主动提醒：`，并在网关状态里标明 `realProvider: false`。

构建和测试的原始输出在 `docs/evidence/companion-platform-logs.zip`。压缩包里的 `manifest.txt` 绑定代码 commit `a066c9460fbbbc8e206d093682111caf7304daa8`。当时 Node v22.23.4，`npm test`、`npm run typecheck`、`npm run build`、`npm run e2e` 的退出码都是 0。这次记录没有覆盖更早的失败日志，因为这四条命令一次通过。夹具浏览器聊天不算真实模型通过。

| # | 项 | 状态 | 依据 |
| --- | --- | --- | --- |
| 1 | 管理员邀请码 | 完成 | CLI `init-admin` 只从环境变量读密码且不打印密码；第二次初始化失败。邀请码明文只返回一次，库存的是 SHA-256。HTTP 测试检查列表不含明文码。 |
| 2 | 邀请注册 | 完成 | 邮箱 + 密码 + 邀请码。并发注册同一码只有一个 201。密码用 scrypt。 |
| 3 | 登录退出 | 完成 | HttpOnly `cp_session`，库里只存 token 的哈希。退出后会话失效。浏览器测试走了登录和退出。失败登录有次数限制，日志不记密码。 |
| 4 | 建角色 | 完成 | 创建、复制、删除。浏览器测试创建了角色「林」。 |
| 5 | 编辑人格 | 完成 | 身份、背景、特征、风格、习惯、关系和规则单独保存在角色上。人格不是记忆表里的行。另有两张标成示例的内置模板，选中后创建的是用户自己的角色，可编辑、可复制。人格卡导出再导入，不携带记忆。 |
| 6 | 真实角色聊天 | BLOCKED | 没有供应商 Key，不能把真实模型端到端标成通过。服务端网关代码走 OpenAI 兼容 `POST /chat/completions` 流式协议；无 Key 为 503；连不上提供者时 SSE 报 `provider_unreachable`，响应里没有 Key，也没有夹具前缀。 |
| 7 | 对话持久化 | 完成 | 会话和消息写入 SQLite。HTTP 测试关掉数据库再打开，消息仍在。浏览器测试退出再登录后能打开标题为「浏览器你好」的会话。持久化的助手文本在没有 Key 时只可能是夹具文本。 |
| 8 | 记忆 CRUD | 完成 | 按角色增删改，带来源、备注、`created_at`、`updated_at`。JSON、JSONL、Markdown、TXT 和本产品 Memory Package 先预览、分类、去重，确认后才写入该角色。导出的记忆包可以导回，重复导入不会再写一条。另一个账号不能读或提交这份预览。ChatGPT、Gemini、DeepSeek 适配器未实现。模型建议保持 `suggested`，默认不当明确事实。 |
| 9 | 两空间隔离 | 完成 | Workspace 与 Companion 会话分开。Workspace 提示词不含陪伴记忆。陪伴不能把工作区附件当作自己的附件。 |
| 10 | 授权时间线 | 完成 | 可授权标题、摘要等具体字段；撤销后读不到。每次陪伴读取写审计。`POST /api/companion/timeline/:id` 返回 405，不能改工作区。 |
| 11 | 主动消息 | 部分 | 已实现：开关、UTC 免打扰、每日上限、幂等键、单次最多有限次模型调用、应用内通知。一条已授权时间线事件生成一条主动消息，并行 tick 只打一次模型。未实现：定时、工作事件、历史跟进、日期提醒；调用这些类型会返回 `trigger_not_implemented`。不是手机后台。 |
| 12 | 重登数据保留 | 完成 | 同一 SQLite 文件重启进程后角色和消息还在。浏览器退出再登录后记忆和会话链接还在。 |
| 13 | 跨账号拒绝 | 完成 | 另一个账号访问角色、会话、记忆、附件得到 404，不返回正文。 |
| 14 | 前端无 Key | 完成 | 页面没有 Key 输入。构建产物不含 `DEEPSEEK_API_KEY`。网关响应和错误日志会删掉密钥形状的字符串。浏览器测试检查 localStorage 不含测试 Key。 |
| 15 | 真实构建测试日志 | 完成 | `npm test`、`npm run typecheck`、`npm run build`、`npm run e2e` 的原始输出打进证据包，并写明 commit、Node 版本、系统和退出码。失败输出不会被成功日志覆盖。 |

## 完成

- 管理员初始化、邀请码、注册、会话、资料。
- 角色、独立人格、两张示例模板、默认模型、记忆 CRUD、复制角色。
- 记忆包和人格卡分开导入导出。确认后才写入指定角色，重复导入不会再写一条。
- 多会话、编辑、重新生成和分支、附件所有权。
- 服务端模型网关、模型列表、流式输出、额度计数。无 Key 时明确不可用。
- Markdown、Prism、KaTeX、Mermaid（复用 chat-demo 固定 commit 的渲染器）。
- 工作区项目、任务、时间线，以及字段级授权、撤销和审计。
- 一种主动触发：已授权时间线事件。
- 管理统计、用户额度、反馈、隐私说明、数据导出和删除。
- 记忆文件预览：JSON、JSONL、Markdown、TXT，以及 ChatGPT / Gemini / DeepSeek 会话片段的有限适配。推测内容不会标成明确事实。
- 桌面和 390px 宽视口的主路径。

## 部分

- 主动消息只有已授权时间线这一种触发。
- 工作区项目和任务可以创建和列出，没有更完整的进度看板。
- 历史导入导出：本产品人格卡和记忆包可以往返。账号导出包含自己的数据。ChatGPT、Gemini、DeepSeek 适配器未实现；DeepSeek ZIP（`export_format_version: 3`）会明确拒绝。
- 深度思考：请求里可以带 thinking，夹具会回一段 `fixture-reasoning`。没有真实模型的思考内容。
- 费用：有配置单价且提供者返回 usage 时记为 `calculated`，这是单价乘用量，不是账单。没有单价时是 `unknown`。夹具是 `fixture`。

## 未完成

- 真实 DeepSeek 对话验收。
- 支付、订阅和购买。
- 多供应商、生图、长期记忆压缩、冲突处理和角色演化。
- 手机推送、Android APK、iOS 包。本环境没有 Android SDK，也没有 macOS/Xcode。
- 语音、联网搜索、链接阅读。
- 定时、工作事件、历史跟进、日期提醒。

## 下一步

1. 管理员在服务端配置 `DEEPSEEK_API_KEY` 后，用 `MODEL_GATEWAY_MODE=live` 复测一条真实流式回复，再把第 6 项从 BLOCKED 改为实测结果。
2. 若要导入 DeepSeek 历史 ZIP，按 chat-demo 文档里的 version 3 包单独做解析和预览，仍然要用户确认后才写入。
3. 响应式 Web 稳定之后，再评估 Capacitor。没有 SDK 之前不要声称有移动安装包。
