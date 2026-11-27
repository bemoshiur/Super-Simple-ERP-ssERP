'use client'
import AppLogo from '@/components/AppLogo'
import Icon from '@/components/wrappers/Icon'
import { useNavState } from '@/context/useNavState'
import BranchSelector from './BranchSelector'
import { DRAWER_ID, SIDEBAR_ID } from './Sidebar'
import UserMenu from './UserMenu'

/** Sticky top bar: navigation toggles, brand (mobile only), branch selector and account menu. */
const TopBar = () => {
  const { collapsed, toggleCollapsed, drawerOpen, setDrawerOpen } = useNavState()
  return (
    <header className="ss-topbar">
      {/* below lg: opens the drawer */}
      <button type="button" className="ss-icon-btn d-lg-none" aria-label="Open navigation" aria-controls={DRAWER_ID} aria-expanded={drawerOpen} onClick={() => setDrawerOpen(true)}>
        <Icon icon="menu" />
      </button>
      {/* lg and up: full column <-> icon rail (remembered per browser) */}
      <button
        type="button"
        className="ss-icon-btn d-none d-lg-inline-flex"
        aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
        aria-controls={SIDEBAR_ID}
        aria-expanded={!collapsed}
        onClick={toggleCollapsed}
      >
        <Icon icon={collapsed ? 'panel-left-open' : 'panel-left-close'} />
      </button>
      <AppLogo className="ss-topbar__brand d-lg-none" />
      <div className="ss-topbar__spacer" />
      <div className="ss-topbar__actions">
        <BranchSelector />
        <UserMenu />
      </div>
    </header>
  )
}

export default TopBar
