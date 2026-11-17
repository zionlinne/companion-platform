import { create } from 'zustand'
import type { Source } from '../../services/chat/view.js'

type Panel = { entry: string | null; sources: Source[] }

export const useSearchPanel = create<Panel>(() => ({ entry: null, sources: [] }))

export function closeSearchPanel() {
  if (useSearchPanel.getState().entry) useSearchPanel.setState({ entry: null, sources: [] })
}

export function toggleSearchPanel(entry: string, sources: Source[]) {
  const current = useSearchPanel.getState()
  useSearchPanel.setState(current.entry === entry ? { entry: null, sources: [] } : { entry, sources })
}
