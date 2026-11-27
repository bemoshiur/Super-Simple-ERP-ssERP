'use client'
import { NavStateProvider, useNavState } from '@/context/useNavState'
import { ShellProvider, type ShellState } from '@/context/useShellContext'
import type { ReactNode } from 'react'
import Footer from './components/Footer'
import { NavDrawer, Sidebar } from './components/Sidebar'
import TopBar from './components/TopBar'

type Props = ShellState & {
  children: ReactNode
  /** Initial desktop navigation width (from the `ss_nav` cookie, so the server render already matches). */
  navCollapsed?: boolean
  /** Admin notices rendered above the page (e.g. pending database migrations). */
  banner?: ReactNode
}

const Frame = ({ children, banner }: { children: ReactNode; banner?: ReactNode }) => {
  const { collapsed } = useNavState()
  return (
    <div className="ss-shell" data-nav={collapsed ? 'collapsed' : 'expanded'}>
      <Sidebar />
      <NavDrawer />
      <div className="ss-frame">
        <TopBar />
        <main id="main-content" className="ss-content" tabIndex={-1}>
          {banner}
          {children}
        </main>
        <Footer />
      </div>
    </div>
  )
}

/** The signed-in application shell: skip link, navigation (column on desktop, drawer on mobile), top bar, footer. */
const MainLayout = ({ children, menu, user, branch, navCollapsed = false, banner }: Props) => (
  <ShellProvider value={{ menu, user, branch }}>
    <NavStateProvider initialCollapsed={navCollapsed}>
      <a href="#main-content" className="ss-skip-link">
        Skip to main content
      </a>
      <Frame banner={banner}>{children}</Frame>
    </NavStateProvider>
  </ShellProvider>
)

export default MainLayout
