export type ChatHost = {
  space: 'workspace' | 'companion'
  characterId: string | null
  getModel: () => string
  navigate: (path: string) => void
}

let host: ChatHost | null = null

export function bindChatHost(next: ChatHost | null) {
  host = next
}

export function getChatHost() {
  return host
}
