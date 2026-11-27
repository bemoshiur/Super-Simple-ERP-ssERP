import Link from 'next/link'

/** Users | Roles switcher shown on both pages (server component). */
const AdminTabs = ({ active, showRoles = true }: { active: 'users' | 'roles'; showRoles?: boolean }) => (
  <ul className="nav nav-tabs mb-3">
    <li className="nav-item">
      <Link href="/users" className={`nav-link${active === 'users' ? ' active' : ''}`} aria-current={active === 'users' ? 'page' : undefined}>
        Users
      </Link>
    </li>
    {showRoles && (
      <li className="nav-item">
        <Link href="/roles" className={`nav-link${active === 'roles' ? ' active' : ''}`} aria-current={active === 'roles' ? 'page' : undefined}>
          Roles &amp; permissions
        </Link>
      </li>
    )}
  </ul>
)

export default AdminTabs
