import { describe, expect, it } from 'vitest'
import { PERMISSIONS } from '../rbac'
import { generatePassword, passwordChoiceSchema } from './passwords'
import { canGrant, effectivePermissions, isPermission, isReservedRoleName, isStrictlyBelow, missingPermissions, normalizeRoleName, passwordField, permissionsField, roleEditRules, roleNameField, roleNameKey } from './policy'

describe('role names', () => {
  it('normalises width, invisible characters and whitespace', () => {
    expect(normalizeRoleName('  Ｓｈｏｐ​   Lead ')).toBe('Shop Lead')
    expect(roleNameKey('Shop  LEAD')).toBe(roleNameKey('shoplead'))
  })
  it.each(['admin', 'ADMIN', ' Admin ', 'ad min', 'ａｄｍｉｎ', 'ad​min', 'A\tDMIN'])('reserves %j', (n) => expect(isReservedRoleName(n)).toBe(true))
  it.each(['administrator', 'admins', 'sub admin x'])('allows %j', (n) => expect(isReservedRoleName(n)).toBe(false))
  it('enforces 2..40 characters after normalising', () => {
    expect(roleNameField.safeParse(' a ').success).toBe(false)
    expect(roleNameField.safeParse('ab').data).toBe('ab')
    expect(roleNameField.safeParse('x'.repeat(41)).success).toBe(false)
    expect(roleNameField.safeParse('​​').success).toBe(false)
  })
})

describe('permissions', () => {
  it('accepts only catalog keys, dedupes and orders by catalog', () => {
    expect(permissionsField.parse(['sales.view', 'activity.view', 'sales.view', 'products.edit'])).toEqual(['products.edit', 'sales.view', 'activity.view'])
    expect(permissionsField.safeParse(['sales.view', 'sales.approve']).success).toBe(false)
    expect(permissionsField.safeParse(['__proto__']).success).toBe(false)
  })
  it('canGrant: admin anything, others only what they hold', () => {
    const mgr = { adm: false, perms: new Set(['users.edit', 'sales.view']) }
    expect(canGrant(mgr, ['sales.view'])).toBe(true)
    expect(canGrant(mgr, ['sales.view', 'accounts.delete'])).toBe(false)
    expect(missingPermissions(mgr.perms, ['accounts.delete', 'sales.view'])).toEqual(['accounts.delete'])
    expect(canGrant({ adm: true, perms: new Set() }, PERMISSIONS)).toBe(true)
  })
  it('system admin role implicitly has every permission and is immutable', () => {
    expect(effectivePermissions({ isSystem: true, name: 'admin' }, [])).toEqual([...PERMISSIONS])
    expect(effectivePermissions({ isSystem: false, name: 'admin' }, ['sales.view'])).toEqual(['sales.view'])
    expect(roleEditRules({ isSystem: true, name: 'admin' })).toEqual({ canRename: false, canEditPermissions: false, canDelete: false })
    expect(roleEditRules({ isSystem: true, name: 'manager' })).toEqual({ canRename: false, canEditPermissions: true, canDelete: false })
    expect(roleEditRules({ isSystem: false, name: 'x' })).toEqual({ canRename: true, canEditPermissions: true, canDelete: true })
  })
})

describe('passwords', () => {
  it('requires 10+ characters and at most 72 bytes', () => {
    expect(passwordField.safeParse('123456789').success).toBe(false)
    expect(passwordField.safeParse('1234567890').success).toBe(true)
    expect(passwordField.safeParse('অ'.repeat(25)).success).toBe(false) // 75 bytes
  })
  it('generates strong unique passwords', () => {
    const a = generatePassword()
    expect(a).toMatch(/^[A-HJ-NP-Za-km-z2-9]{16}$/)
    expect(new Set(Array.from({ length: 50 }, () => generatePassword())).size).toBe(50)
  })
  it('choice: typed password or generated', () => {
    expect(passwordChoiceSchema.parse({ password: 'longenough1' })).toEqual({ generate: false, password: 'longenough1' })
    expect(passwordChoiceSchema.parse({ generate: 'on', password: 'x' }).password).toHaveLength(16)
    const bad = passwordChoiceSchema.safeParse({ password: 'short' })
    expect(bad.success).toBe(false)
    expect(bad.error?.issues[0].path).toEqual(['password'])
  })
})

describe('isStrictlyBelow (role editor hint and server rule)', () => {
  const me = { adm: false, perms: new Set(['sales.view', 'sales.create', 'customers.view']) }
  it('equal sets are not below; a strict subset is', () => {
    expect(isStrictlyBelow(me, ['sales.view', 'sales.create', 'customers.view'])).toBe(false)
    expect(isStrictlyBelow(me, ['sales.view', 'customers.view'])).toBe(true)
    expect(isStrictlyBelow(me, [])).toBe(true)
  })
  it('a key the actor lacks is never below; admins always are', () => {
    expect(isStrictlyBelow(me, ['sales.view', 'users.edit'])).toBe(false)
    expect(isStrictlyBelow({ adm: true, perms: new Set() }, ['users.edit'])).toBe(true)
  })
  it('a retired key counts as extra unless the caller intersects with the catalog (loadActor and the roles page do)', () => {
    const withRetired = { adm: false, perms: new Set([...me.perms, 'legacy.retired']) }
    expect(isStrictlyBelow(withRetired, [...me.perms])).toBe(true)
    expect(isStrictlyBelow({ adm: false, perms: new Set([...withRetired.perms].filter(isPermission)) }, [...me.perms])).toBe(false)
  })
})
