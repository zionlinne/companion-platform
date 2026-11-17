# Vendored code from deepseek-ai/chat-demo

- Source: https://github.com/deepseek-ai/chat-demo
- Pinned commit: `5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c`
- Commit message: `fix: clarify history import errors and release v0.1.1`
- Commit date: 2026-11-13T14:33:04Z
- License: MIT. Copyright (c) 2026 DeepSeek. The license text is in `LICENSE` beside this file.
- This directory is not the DeepSeek App and does not contain model weights. chat-demo is a browser example that normally asks for an API key and stores chats in IndexedDB.

## Copied

The chat shell and the reply renderer, with the local edits named below:

- `src/components/session/SessionView.tsx` and its CSS
- `src/components/session/MobileHeader.tsx` and its CSS
- `src/components/messages/` message list, user message, assistant message, reply area, branch switcher, copy button, read-aloud button, and their CSS
- `src/components/chatInput/` input, drafts, drag mask, voice button, and their CSS
- `src/components/base/Button.tsx`, `IconButton.tsx`, `Tooltip.tsx`, `anchored.ts`, and their CSS
- `src/components/files/FileCard.tsx`, `FileIcon.tsx`, and CSS
- `src/components/search/SiteLogo.tsx`, `FallbackImage.tsx`, and CSS
- `src/components/markdown/` and `src/services/markdown/` (already present; `CodeBlock.tsx` still has the grammar guard)
- `src/services/chat/view.ts`, `types.ts`, `branches.ts`, `describe.ts`
- `src/services/api/types.ts` (protocol shapes used by the reply view, not a client)
- `src/i18n/zh.ts`, `src/i18n/en.ts`, `src/i18n/index.ts`
- `src/app/theme.css`, `src/app/viewport.ts`
- `src/utils/id.ts`
- `src/components/base/icons.tsx` and `src/utils/clipboard.ts` (already present)

## Local edits inside copied files

- `CodeBlock.tsx`: ignore a missing Prism grammar and escape the code.
- `useVoiceInput.ts`: `AVAILABLE` is false. The browser does not record or send audio.
- `VoiceButton.tsx` and the i18n tables: the disabled voice control says it is not connected.
- `ChatInput.tsx`: test ids for the composer, send, and file input; search cannot be turned on; attachments follow the server upload flag.
- `MobileHeader.tsx`: no sidebar button. The demo sidebar is a browser-local session list. This app already has navigation, and new chat creates a server conversation.
- `MessageList.tsx`: empty state says messages stay on the server and a fixture reply is not DeepSeek.
- `toastState.ts`: shows text without the demo settings store.

## Written here, not copied

These replace the demo's API-key settings, IndexedDB, and direct provider client:

- `src/services/chat/store.ts` sends, edits, regenerates, and switches branches through this server
- `src/services/chat/drafts.ts`, `host.ts`, `db.ts`, `reply.ts`
- `src/services/attachments.ts` uploads only to this server, and only when uploads are enabled
- `src/services/settings.ts` keeps the thinking switch and holds no provider key
- `src/services/api/client.ts` exports the error-kind type only
- `src/services/api/errors.ts` and `speech.ts`
- `src/services/speech/readAloud.ts` and `recorder.ts`
- `src/components/settings/settingsDialogState.ts` does not open a key field
- `src/components/search/searchPanelState.ts`
- `src/app/theme.ts` remains the small theme shim used by Mermaid

Assistant messages are stored with `prefix: false`. The continue-generation control stays hidden, and there is no request that pretends the server can continue a provider prefix.

## Not part of this product

- The demo settings dialog, API key field, and `ensureApiKey` prompt
- The demo HTTP client, speech transcription, and Files API upload to the provider
- IndexedDB sessions, history import/export, and the sidebar session list
- Web search, voice transcription, and read-aloud playback
- `src/app/global.css` body scroll lock, because this app has other pages
