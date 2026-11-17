import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { api, type User } from './api.ts'

type SessionValue = {
  user: User | null
  ready: boolean
  refresh: () => Promise<void>
  setUser: (user: User | null) => void
}

const SessionContext = createContext<SessionValue | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [ready, setReady] = useState(false)
  const refresh = async () => {
    try {
      const data = await api<{ user: User }>('/api/me')
      setUser(data.user)
    } catch {
      setUser(null)
    } finally {
      setReady(true)
    }
  }
  useEffect(() => {
    void refresh()
  }, [])
  return <SessionContext.Provider value={{ user, ready, refresh, setUser }}>{children}</SessionContext.Provider>
}

export function useSession() {
  const value = useContext(SessionContext)
  if (!value) throw new Error('session missing')
  return value
}
