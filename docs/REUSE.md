# 复用清单

这份清单只写已经核对过的项目。Markdown 渲染复用不是整个产品的复用。认证在这个可手测版本里仍是已经测过的自写实现；下一模块会把它换成 Better Auth，不在这次检查点里半替换，也不保留两套登录。

## 已经复用

| 项目 | 固定版本 | 许可证 | 用了什么 | 我们的改动 |
| --- | --- | --- | --- | --- |
| https://github.com/deepseek-ai/chat-demo | commit `5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c`（2026-11-13，v0.1.1） | MIT，Copyright (c) 2026 DeepSeek。全文在 `web/src/vendor/deepseek-chat-demo/LICENSE` | Markdown、Prism 代码高亮、KaTeX、Mermaid。文件列表在同目录 `NOTICE.md` | 只改了 `CodeBlock.tsx` 的语法缺失保护。为了编译写了主题、提示和引用垫片。没有复制它的 API Key 设置、IndexedDB 和直接请求供应商的客户端 |

| https://github.com/ionic-team/capacitor | npm `@capacitor/core`、`@capacitor/android`、`@capacitor/ios`、`@capacitor/cli` `8.6.2` | MIT | Android 壳、iOS 工程模板、WebView 文件选择 | 没有启用 CapacitorHttp 或 CapacitorCookies。地址校验、debug 明文例外和会话 Cookie 策略是本仓库写的。没有把供应商 Key 放进壳 |

React、Vite 和 Playwright 是运行和测试用的依赖，不是把某个聊天产品接进来。

## 查过、这个检查点没有换进去

| 候选 | 核对结果 | 为什么现在不换 |
| --- | --- | --- |
| [Better Auth](https://www.better-auth.com) 1.4.18，仓库 https://github.com/better-auth/better-auth ，npm 记录 2026-11-15 仍在更新，MIT | 官方 SQLite 说明 https://www.better-auth.com/docs/adapters/sqlite 写明可以用 Node 自带的 `node:sqlite` `DatabaseSync`。邮箱密码、数据库会话、重置密码和会话撤销都在库里 | 当前登录、邀请码和对象权限已经有 HTTP 测试。直接换掉会改掉这份可手测版本的会话。库已核对，但没有装进这个检查点，避免出现两套身份。账户模块下一步只保留 Better Auth 这一套，并迁移现有用户表 |
| [Lucia](https://github.com/pilcrowOnPaper/lucia) 3.2.2，MIT | npm 标记 deprecated，指向 https://lucia-auth.com/lucia-v3/migrate ，包更新停在 2025-06-06 | 不采用已停止维护的认证库 |
| [Oslo](https://github.com/pilcrowOnPaper/oslo) 1.2.1，MIT | npm 标记 no longer supported，指向 https://oslojs.dev | 它是底层零件，不是完整的邮箱会话产品。当前不另起一套密码学工具 |

DeepSeek 公开文档有调用参数 `user_id`，用来做内容安全和缓存隔离：https://api-docs.deepseek.com/quick_start/rate_limit 。没有查到可授权的 Token Management API。公开的密钥页面是控制台 https://platform.deepseek.com/api_keys/apiKey ，不是给服务端代管用户密钥的接口。因此不自造管理接口，也不把供应商 Key 交到浏览器。

## 仍自写的部分

邀请码、Workspace 和 Companion 的隔离、5 个 Companion 名额、时间线字段授权、主动消息和记忆包是产品规则。上面这些库没有对应实现。聊天页面、路由和数据库表也是自写的，因为 chat-demo 把 Key 放在浏览器里，不能当作产品外壳。
