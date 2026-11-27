'use client'
import Icon from '@/components/wrappers/Icon'
import { useShell } from '@/context/useShellContext'
import { logoutAction } from '@/server/auth/actions'
import { initials } from '@/utils/initials'
import Link from 'next/link'
import { Dropdown } from 'react-bootstrap'

/** Top-bar account menu: profile, password, sign out. */
const UserMenu = () => {
  const { user } = useShell()
  return (
    <Dropdown align="end" id="user-menu">
      <Dropdown.Toggle as="button" type="button" className="ss-user-toggle">
        <span className="ss-initials" aria-hidden="true">
          {initials(user.name)}
        </span>
        <span className="visually-hidden">Account menu: </span>
        <span className="visually-hidden d-md-none">{user.name}</span>
        <span className="d-none d-md-inline text-truncate" style={{ maxWidth: '12rem' }}>
          {user.name}
        </span>
        <Icon icon="chevron-down" className="d-none d-md-inline text-muted" aria-hidden="true" />
      </Dropdown.Toggle>
      <Dropdown.Menu className="ss-user-menu">
        <div className="dropdown-header">
          <div className="fw-bold text-truncate">{user.name}</div>
          <div className="small text-muted text-truncate">{user.email}</div>
          <span className="badge text-bg-light border mt-2 text-capitalize">{user.role}</span>
        </div>
        <Dropdown.Divider />
        <Dropdown.Item as={Link} href="/account">
          <Icon icon="user" aria-hidden="true" /> My profile
        </Dropdown.Item>
        <Dropdown.Item as={Link} href="/account/password">
          <Icon icon="key-round" aria-hidden="true" /> Change password
        </Dropdown.Item>
        <Dropdown.Divider />
        <form action={logoutAction}>
          <button type="submit" className="dropdown-item text-danger fw-semibold">
            <Icon icon="log-out" aria-hidden="true" /> Sign out
          </button>
        </form>
      </Dropdown.Menu>
    </Dropdown>
  )
}

export default UserMenu
