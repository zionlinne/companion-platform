# Vendored code from deepseek-ai/chat-demo

- Source: https://github.com/deepseek-ai/chat-demo
- Pinned commit: `5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c`
- Commit message: `fix: clarify history import errors and release v0.1.1`
- Commit date: 2026-11-13T14:33:04Z
- License: MIT. Copyright (c) 2026 DeepSeek. The license text is in `LICENSE` beside this file.
- This directory is not the DeepSeek App and does not contain model weights.

## Copied with only the local fixes named below

- `src/components/markdown/` except the `CodeBlock.tsx` fixes
- `src/services/markdown/`
- `src/utils/clipboard.ts`
- `src/components/base/icons.tsx`
- `src/components/messages/scrollContext.ts`

## Local fixes inside otherwise copied files

- `src/components/markdown/CodeBlock.tsx`
  - Ignore a failed Prism language import.
  - If Prism has no grammar (including `plaintext`), escape the code instead of calling `Prism.highlight` with an empty grammar.

## Written here, not copied

These files exist so the renderer can compile without the upstream API-key settings store, IndexedDB chat store, or search hover cards:

- `src/services/chat/view.ts` (citation `Source` type only)
- `src/i18n/index.ts`
- `src/components/base/toastState.ts`
- `src/app/theme.ts`
- `src/components/search/CitationLink.tsx`

The upstream API client, settings screen, and conversation store are intentionally absent. Companion Platform does not ask ordinary users for a provider API key.
