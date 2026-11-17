import { useSyncExternalStore } from 'react'

export type Theme = 'light' | 'dark'

const query = () => window.matchMedia('(prefers-color-scheme: dark)')

export const useTheme = (): Theme =>
  useSyncExternalStore(
    (listener) => {
      const media = query()
      media.addEventListener('change', listener)
      return () => media.removeEventListener('change', listener)
    },
    () => (document.body.classList.contains('dark') || query().matches ? 'dark' : 'light')
  )
