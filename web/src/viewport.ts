import { useEffect } from 'react'

export function useVisibleViewport() {
  useEffect(() => {
    const apply = () => {
      const viewport = window.visualViewport
      const full = window.innerHeight || 0
      const visible = viewport?.height || full
      const keyboard = full > 0 && visible > 0 ? Math.max(0, Math.round(full - visible - (viewport?.offsetTop ?? 0))) : 0
      document.documentElement.style.setProperty('--keyboard', `${keyboard}px`)
    }
    apply()
    window.visualViewport?.addEventListener('resize', apply)
    window.visualViewport?.addEventListener('scroll', apply)
    window.addEventListener('resize', apply)
    return () => {
      window.visualViewport?.removeEventListener('resize', apply)
      window.visualViewport?.removeEventListener('scroll', apply)
      window.removeEventListener('resize', apply)
    }
  }, [])
}
