import { create } from 'zustand'
import type { TranslationMessage } from '../../i18n/index.js'

type Status = 'idle' | 'loading' | 'playing'

export const useReadAloud = create<{ messageId: string | null; status: Status }>(() => ({
  messageId: null,
  status: 'idle',
}))

export function toggleReadAloud(_messageId: string, _text: string, onError: (error: unknown) => void) {
  onError(new Error('tts_unavailable'))
}

export function stopReadAloud() {}

export function describeReadAloudError(_error: unknown): TranslationMessage {
  return { key: 'ttsUnavailable' }
}
