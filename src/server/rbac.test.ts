import { describe, expect, it } from 'vitest'
import { DEFAULT_ROLE_PERMISSIONS, ForbiddenError, MODULES, PERMISSIONS, UnauthorizedError, can, requirePermission } from './rbac'

describe('rbac', () => {
  it('catalog covers every module x action plus activity.view and branches.all', () => {
    expect(PERMISSIONS).toHaveLength(MODULES.length * 4 + 2)
    expect(PERMISSIONS).toContain('branches.all')
    expect(DEFAULT_ROLE_PERMISSIONS.manager).toContain('branches.all')
    expect(DEFAULT_ROLE_PERMISSIONS.salesman).not.toContain('branches.all')
    expect(PERMISSIONS).toContain('serials.create')
    expect(PERMISSIONS).toContain('activity.view')
  })
  it('admin has all, manager lacks users/settings.delete only', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.admin).toEqual(PERMISSIONS)
    expect(PERMISSIONS.filter((p) => !DEFAULT_ROLE_PERMISSIONS.manager.includes(p))).toEqual(['users.delete', 'settings.delete'])
  })
  it('salesman has sales/customers/serials view+create only', () => {
    expect([...DEFAULT_ROLE_PERMISSIONS.salesman].sort()).toEqual(
      ['sales', 'customers', 'serials'].flatMap((m) => [`${m}.view`, `${m}.create`]).sort(),
    )
  })
  it('can(): admin always passes, others need the key, null denies', () => {
    expect(can({ adm: true, perms: [] }, 'users.delete')).toBe(true)
    expect(can({ adm: false, perms: ['sales.view'] }, 'sales.view')).toBe(true)
    expect(can({ adm: false, perms: ['sales.view'] }, 'sales.delete')).toBe(false)
    expect(can({ adm: false, perms: [] }, 'sales.view')).toBe(false)
    expect(can(null, 'sales.view')).toBe(false)
  })
  it('role name alone never grants admin', () => {
    expect(can({ role: 'admin', adm: false, perms: [] } as never, 'users.delete')).toBe(false)
  })
  it('requirePermission throws typed errors', () => {
    const s = { adm: false, perms: ['sales.view'] }
    expect(requirePermission(s, 'sales.view')).toBe(s)
    expect(() => requirePermission(s, 'users.delete')).toThrow(ForbiddenError)
    expect(() => requirePermission(null, 'sales.view')).toThrow(UnauthorizedError)
  })
})
