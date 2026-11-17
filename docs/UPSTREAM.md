# 上游核对与复用决定

核对日期：2026-11-17。下面的结论来自当时读到的官方页面和仓库文件，不是推测。

## 用户提到的「放出了 app 权重」对应什么

这句话和 2026-11-13 的官方发布不一致。官方发布的是应用能力 API 和一个前端演示的源码，不是可以拿来直接跑的「App 权重」。

| 来源 | 实际内容 |
| --- | --- |
| https://api-docs.deepseek.com/news/news261113/ | 英文公告：The full DeepSeek App experience, now via API。开放搜索、文件、链接、安全、OCR/ASR/TTS，并指向开源前端 demo。 |
| https://api-docs.deepseek.com/zh-cn/news/news261113/ | 中文公告：全家桶应用 API。明确写的是接口和一份轻量前端 Demo，不是权重文件。 |
| https://api-docs.deepseek.com/updates/ | 变更日志 2026-11-13，标题为 Releasing the full suite of application APIs。 |
| https://api-docs.deepseek.com/guides/build_a_chatbot/ | 说明 demo 要用户自己输入 API key，数据留在浏览器。 |
| https://api-docs.deepseek.com/news/news260424 | 更早的 DeepSeek-V4 Preview。这里才写了 Hugging Face 上的开放权重。那是模型权重，不是 App，也不是 chat-demo。 |
| https://www.deepseek.com/en/news/deepseek-app/ | 2025-01-15 的 App 上线说明，不是权重发布。 |

模型权重（V4-Pro / V4-Flash 等）体量是数千亿到万亿参数。本仓库没有下载、没有打包、也没有声称能本地运行这些权重。

## chat-demo 仓库

- 存在：https://github.com/deepseek-ai/chat-demo
- 创建时间：2026-11-12T08:08:19Z
- 固定 commit：`5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c`
- 提交说明：`fix: clarify history import errors and release v0.1.1`
- 提交时间：2026-11-13T14:33:04Z
- 许可证：仓库根目录 `LICENSE` 全文是 MIT License，Copyright (c) 2026 DeepSeek。这是读文件得到的，不是事先假定。GitHub API 的 SPDX 也标为 MIT。
- 目录：`src/app`、`src/components`、`src/i18n`、`src/services/{api,chat,markdown,speech}`、`src/utils`，加上 `package.json`、`rspack.config.ts`。
- 依赖：React 18、Zustand、IndexedDB（`idb`）、micromark/mdast、Prism、KaTeX、Mermaid、fflate。没有模型权重或推理运行时。
- README 写明：静态站点，浏览器直接连接配置的 API，用户在设置里输入 API key，key 存在 localStorage，会话存在 IndexedDB。
- README 里的 Releases 链接写成了 `deepseek-ai/deepseek-chat-demo`。用这个名字请求 GitHub 时，返回的仍是 `deepseek-ai/chat-demo` 这个仓库。

## 复用了什么

复用了固定 commit 里的 Markdown 渲染链路，用来保留代码高亮、公式和 Mermaid，而不是重写一个简陋渲染器。

复制进 `web/src/vendor/deepseek-chat-demo/` 的文件、本地修改和为了编译而写的垫片，都记在该目录的 `NOTICE.md`。MIT 许可证全文原样保留。

本地只改了 `CodeBlock.tsx`：Prism 没有对应语法时不再把空 grammar 传进 `highlight`，语言包加载失败时不把页面打崩。

## 没有复用什么

没有把 chat-demo 当成产品外壳，原因是它和本产品的硬约束冲突：

- 它要求普通用户在浏览器里填写供应商 Key。本产品要求普通用户不输入 Key，所有模型调用走服务端网关。
- 它没有账号、服务端会话、对象级权限，也不能把 Workspace 和 Companion 的存储隔开。
- 它的 API 客户端会把 Key 放进 `x-api-key` 或 `Authorization` 请求头。该客户端没有被复制。

因此本仓库的账号、数据库、网关和页面是自己的实现。不能说整个产品基于 chat-demo。

也没有使用 DeepSeek 商标或 Logo。产品标识是文字「Companion Platform」。

DeepSeek 历史 ZIP（`export_format_version: 3`）的完整导入器没有搬过来。记忆导入如果看到这个版本标记会拒绝，并说明 ZIP 历史包尚未支持。
