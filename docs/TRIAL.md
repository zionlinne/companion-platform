# 可手测检查点

这是给人手测交互的版本，不是公开网站，也没有预置试用账号。请在本机启动。没有供应商 Key 时，真实模型对话不可用，页面不能把夹具回复当成 DeepSeek。

手机上的可分发安装包还没有域名，状态是 BLOCKED。debug APK 只作开发证据。本机浏览器可以走邀请注册、Workspace、Companion、人格、对话和记忆。免费部署的 Postgres 准备见 `docs/DEPLOY.md`。

## 启动

需要 Node.js 22。

```sh
npm install
npm run migrate
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='choose-a-long-password' npm run admin:init
npm run admin:invite -- --count 10
npm run build
STATIC_DIR=web/dist npm start
```

浏览器打开 `http://127.0.0.1:8787`。用管理员登录，在「管理」里看到邀请码，退出后再注册。密码只来自你自己导出的环境变量，不会写进仓库。页面和 API 是同一个源。

默认 `MODEL_GATEWAY_MODE=live`。不设置 `DEEPSEEK_API_KEY` 时，发送聊天会得到 `model_gateway_unconfigured`，不会出现假回复。

自动化浏览器测试使用本地夹具，回复以 `fixture-reply:` 或 `主动提醒：` 开头，并且横幅写明不是 DeepSeek。不要为了手测去找旧的 API Key。

## 建议点的路径

1. 首页的 Workspace 和 Companion。
2. Companion 里的示例模板、人格保存、复制上限提示。名额是每个账号 5 个。
3. 一个角色的聊天。没有 Key 时应明确失败。
4. 记忆页：粘贴 Memory Package，预览后再确认，然后导出。再预览同一次导出，应显示重复。
5. Workspace 时间线新增一条，授权页只勾选要给某个角色的字段，再撤销。
6. 设置里打开主动消息并点「立即检查主动消息」。没有 Key 时不会编一条主动消息。通知页只显示真正生成的应用内通知。

## 这版没有

- 真实 DeepSeek 对话。
- 邮箱验证、重置密码、钱包、充值和支付。认证替换还没做，避免两套登录。
- ChatGPT、Gemini、DeepSeek 历史包导入。
- 定时、工作事件、历史跟进、日期提醒。
- 公网地址。Android debug 壳见 `docs/ANDROID.md`，装上不等于能聊天。
