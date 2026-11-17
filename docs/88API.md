# 88API 网关适配

这是给本地交互试用的服务端适配，不是公开部署。普通用户仍然不能填写自己的 Key。密钥只放在启动进程的环境变量里。

## 核对过的文档

- 88API Chat Completions：<https://88api.ai/en/docs/api/chat/openai-chat/>。示例地址是 `POST https://api.88api.ai/v1/chat/completions`。`temperature` 的通用范围是 0 到 2。同一页把 `reasoning_effort` 写成 o-series 的 `low`、`medium`、`high`。
- 88API 模型列表：<https://88api.ai/cn-models/>。当前列出 `deepseek-v4.1-flash`，调用基址是 `https://api.88api.ai/v1`。令牌是否有权调用这个模型，文档没有保证，本仓库也没有用真实令牌探测。
- DeepSeek 思考模式：<https://api-docs.deepseek.com/guides/thinking_mode>。`reasoning_effort` 为 `low`、`high`、`max` 时打开思考。
- DeepSeek Chat Completions：<https://api-docs.deepseek.com/api/create-chat-completion>。`temperature` 范围是 0 到 2，并写明思考模式下没有效果。`none` 才关闭思考。

因此默认请求只带 `reasoning_effort: "low"`，不带 `temperature`，也不带 `thinking`。不能把最高温度和 low 思考说成同时生效。只有把 `REASONING_EFFORT` 设为 `none` 时才会发送 `TEMPERATURE`。`medium` 会被拒绝，避免把 88API 通用页上的 o-series 示例悄悄映射成别的档位。

## 给 07ec01e 手测目录的 Windows 替换

用户电脑上的固定版本是 `07ec01ebd59b2e5da026b5d30582baf4f1caa11b`。不要把账户和钱包那一版覆盖上去，也不要替换数据库、`.env`、密钥或 `node_modules`。没有新增 npm 依赖。

先停掉正在运行的服务。在该提交的目录里，只替换这些文件：

- `server/src/upstream-request.ts`（新文件）
- `server/src/gateway.ts`
- `server/src/config.ts`
- `server/src/create-app.ts`（只增加网关状态里的非密钥字段）
- `server/test/upstream-request.test.ts`（新文件）
- `docs/88API.md`

可应用补丁是 `docs/patches/88api-gateway-07ec01e.patch`，替换文件包是 `docs/patches/88api-gateway-07ec01e-files.zip`。补丁父提交是 `07ec01ebd59b2e5da026b5d30582baf4f1caa11b`，补丁提交是 `414398fdeb6b0e9d7d79de3d08140f9166e7100c`，分支 `cursor/88api-gateway-07ec01e-7b4d`。账户钱包分支另外保留了同一套请求拼接。原始日志在 `docs/evidence/88api-gateway-07ec01e-logs.zip`。

在原来的目录打开 PowerShell，变量名和试用值如下。Key 只是占位，换成你自己的 88API 令牌，不要写进仓库：

```powershell
$env:MODEL_GATEWAY_MODE = "live"
$env:DEEPSEEK_BASE_URL = "https://api.88api.ai/v1"
$env:DEEPSEEK_API_KEY = "sk-replace-with-your-88api-token"
$env:DEEPSEEK_MODEL = "deepseek-v4.1-flash"
$env:REASONING_EFFORT = "low"
$env:TEMPERATURE = "2"
npm start
```

`TEMPERATURE=2` 会被读入并校验，但在 `REASONING_EFFORT=low` 时不会放进上游 JSON。页面上的思考开关也不再额外添加 `thinking` 或 `temperature`。`/api/gateway` 会返回 `sampling: "thinking-temperature-omitted"`，并且不返回密钥。

没有 `DEEPSEEK_API_KEY` 时，live 请求在发出之前失败，错误码是 `model_gateway_unconfigured`。这不是夹具回复。夹具模式仍然只有显式 `ALLOW_GATEWAY_FIXTURE=1` 才会启动，它的回复不能当成 88API 或 DeepSeek。

服务器用 `node --experimental-strip-types` 直接跑 TypeScript，这几项替换不需要重新 `npm install`。前端包没有改。若要在本机复查，可以在替换后的目录运行 `npm test`、`npm run typecheck` 和 `npm run build`。
