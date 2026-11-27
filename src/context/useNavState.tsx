'use client'
import { NAV_COOKIE } from '@/config/constants'
import { createContext, use, useCallback, useMemo, useState, type ReactNode } from 'react'

type NavState = {
  /** Desktop: icon rail instead of the full column. Persisted per browser. */
  collapsed: boolean
  toggleCollapsed: () => void
  /** Mobile: the off-canvas drawer is open. */
  drawerOpen: boolean
  setDrawerOpen: (open: boolean) => void
}

const NavContext = createContext<NavState | null>(null)

export function NavStateProvider({ initialCollapsed, children }: { initialCollapsed: boolean; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(initialCollapsed)
  const [drawerOpen, setDrawerOpen] = useState(false)

  const toggleCollapsed = useCallback(() => {
    const next = !collapsed
    setCollapsed(next)
    document.cookie = `${NAV_COOKIE}=${next ? 'collapsed' : 'expanded'}; path=/; max-age=31536000; samesite=lax`
  }, [collapsed])

  const value = useMemo(() => ({ collapsed, toggleCollapsed, drawerOpen, setDrawerOpen }), [collapsed, toggleCollapsed, drawerOpen])
  return <NavContext value={value}>{children}</NavContext>
}

export function useNavState(): NavState {
  const ctx = use(NavContext)
  if (!ctx) throw new Error('useNavState must be used inside NavStateProvider')
  return ctx
}
