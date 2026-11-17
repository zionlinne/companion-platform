import { create } from 'zustand'

export type ThemePreference = 'system' | 'light' | 'dark'

type Settings = {
  locale: 'zh-CN' | 'en-US'
  themePreference: ThemePreference
  thinking: boolean
  search: boolean
  apiKey: string
  siderCollapsed: boolean
}

/** No provider key is stored here. Search cannot be turned on. */
export const useSettings = create<Settings>(() => ({
  locale: 'zh-CN',
  themePreference: 'light',
  thinking: false,
  search: false,
  apiKey: '',
  siderCollapsed: true,
}))

export function setThinking(thinking: boolean) {
  useSettings.setState({ thinking })
}

export function setSearch(_search: boolean) {
  useSettings.setState({ search: false })
}
