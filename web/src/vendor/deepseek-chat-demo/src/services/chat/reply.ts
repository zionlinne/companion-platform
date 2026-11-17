import type { AssistantMessage } from './types.js'

/**
 * Same gate as the chat shell: a reply can continue only when it was marked as a prefix.
 * Companion messages set prefix to false, and this server has no continue-generation call.
 * The upstream function that builds a direct provider request is not included.
 */
export const canContinueReply = (reply: AssistantMessage): boolean => {
  if (
    !reply.prefix ||
    reply.stopReason === 'refusal' ||
    reply.stopReason === 'tool_use' ||
    reply.blocks.some(
      (block) =>
        block.type === 'server_tool_use' ||
        block.type === 'web_search_tool_result' ||
        block.type === 'web_fetch_tool_result' ||
        (block.type === 'text' && block.isTemplate)
    )
  ) {
    return false
  }
  return reply.status === 'stopped' || (reply.status === 'done' && reply.stopReason === 'max_tokens')
}
