'use client'
import AppLogo from '@/components/AppLogo'
import Icon from '@/components/wrappers/Icon'
import { useNavState } from '@/context/useNavState'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { Offcanvas } from 'react-bootstrap'
import NavMenu from './NavMenu'

export const SIDEBAR_ID = 'ss-sidebar'
export const DRAWER_ID = 'ss-drawer'

/** Brand, menu and foot line: the same content in the desktop column and in the mobile drawer. */
const NavPanel = ({ onNavigate, onClose }: { onNavigate?: () => void; onClose?: () => void }) => (
  <div className="ss-navpanel">
    <div className="ss-navpanel__brand">
      <AppLogo tone="light" />
      {onClose && (
        <button type="button" className="ss-icon-btn ss-drawer__close" onClick={onClose} aria-label="Close navigation">
          <Icon icon="x" />
        </button>
      )}
    </div>
    <div className="ss-navpanel__scroll">
      <NavMenu onNavigate={onNavigate} />
    </div>
    <div className="ss-navpanel__foot">Inventory · Billing · Serials</div>
  </div>
)

/** Desktop navigation column (CSS shows it from the lg breakpoint up). */
export const Sidebar = () => (
  // A plain wrapper: the <nav aria-label="Main menu"> inside is the only navigation landmark.
  <div className="ss-sidebar" id={SIDEBAR_ID}>
    <NavPanel />
  </div>
)

const DESKTOP = '(min-width: 992px)' // Bootstrap's lg breakpoint, as in _layout.scss

/** Mobile navigation: an off-canvas drawer (focus trap, Escape and backdrop come from Bootstrap's Offcanvas). */
export const NavDrawer = () => {
  const { drawerOpen, setDrawerOpen } = useNavState()
  const pathname = usePathname()
  const [lastPath, setLastPath] = useState(pathname)
  if (pathname !== lastPath) {
    // a link inside the drawer was followed: close it
    setLastPath(pathname)
    if (drawerOpen) setDrawerOpen(false)
  }

  // Growing the window past the breakpoint swaps the drawer for the column: never leave a hidden drawer "open".
  useEffect(() => {
    const mq = window.matchMedia(DESKTOP)
    const onChange = () => mq.matches && setDrawerOpen(false)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [setDrawerOpen])

  const close = () => setDrawerOpen(false)
  return (
    <Offcanvas show={drawerOpen} onHide={close} placement="start" id={DRAWER_ID} className="ss-drawer" aria-label="Navigation">
      <NavPanel onClose={close} />
    </Offcanvas>
  )
}
