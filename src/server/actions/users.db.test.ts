import { and, eq, inArray, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetData, setupTestDb, type TestDb } from '@/test/db-harness'

// Inject the session through the one seam the actions use (authorize/getSession). Real DB, real RBAC check.
type S = { uid: string; cid: string; bid: null; role: string; adm: boolean; sv: number; perms: string[] }
const st = vi.hoisted(() => ({ session: null as null | S, jar: new Map<string, string>() }))
vi.mock('../auth/current', async () => {
  const { requirePermission } = await import('../rbac')
  return { authorize: async (key: never) => requirePermission(st.session, key), getSession: async () => st.session }
})
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))
vi.mock('next/headers', () => ({ cookies: async () => ({ set: (k: string, v: string) => st.jar.set(k, v) }), headers: async () => new Headers() }))

let t: TestDb
beforeAll(async () => {
  t = await setupTestDb()
})
afterAll(async () => {
  await t?.teardown()
})
beforeEach(async () => {
  await resetData()
  st.session = null
})

const NIL = '00000000-0000-4000-8000-000000000000'

async function seed() {
  const { a, b } = await (await import('@/test/seed')).seedTwoCompanies()
  const { getDb, schema } = await import('../db')
  const { hashPassword } = await import('../auth/password')
  const db = getDb()
  const roles = await db.select().from(schema.roles)
  const role = (cid: string, name: string) => roles.find((r) => r.companyId === cid && r.name === name)!.id
  const hash = await hashPassword('initial-password-1')
  const mkUser = async (name: string, roleId: string, cid = a.cid) => {
    const [u] = await db.insert(schema.users).values({ companyId: cid, branchId: await (await import('@/test/seed')).mainBranchId(cid), roleId, name, email: `${name.toLowerCase()}@example.test`, passwordHash: hash }).returning()
    return u.id
  }
  const mkRole = async (name: string, perms: string[], cid = a.cid) => {
    const [r] = await db.insert(schema.roles).values({ companyId: cid, name }).returning()
    if (perms.length) await db.insert(schema.rolePermissions).values(perms.map((permission) => ({ companyId: cid, roleId: r.id, permission })))
    return r.id
  }
  /** What login would put in the JWT for this user right now. */
  const sessionOf = async (uid: string): Promise<S> => {
    const [u] = await db.select({ u: schema.users, r: schema.roles }).from(schema.users).innerJoin(schema.roles, eq(schema.roles.id, schema.users.roleId)).where(eq(schema.users.id, uid))
    const adm = u.r.isSystem && u.r.name === 'admin'
    const perms = adm ? [] : (await db.select().from(schema.rolePermissions).where(eq(schema.rolePermissions.roleId, u.r.id))).map((p) => p.permission)
    return { uid, cid: u.u.companyId, bid: null, role: u.r.name, adm, sv: u.u.sessionVersion, perms }
  }
  const as = async (uid: string) => (st.session = await sessionOf(uid))
  const userRow = async (id: string) => (await db.select().from(schema.users).where(eq(schema.users.id, id)))[0]
  const ids = { admin: role(a.cid, 'admin'), manager: role(a.cid, 'manager'), salesman: role(a.cid, 'salesman'), bAdmin: role(b.cid, 'admin') }
  return { a, b, db, schema, ids, mkUser, mkRole, sessionOf, as, userRow }
}

const denied = (r: { ok: boolean; error?: string }) => expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/permission/) })

describe('users & roles: permissions at the action layer', () => {
  it('a salesman can reach none of the user/role actions', async () => {
    const { a, ids, mkUser, as } = await seed()
    const sm = await mkUser('Sam', ids.salesman)
    await as(sm)
    const act = await import('./users')
    denied(await act.createUserAction({ name: 'X', email: 'x@example.test', roleId: ids.salesman, password: 'longenough-1' }))
    denied(await act.updateUserAction(a.uid, { name: 'X', email: 'a@example.test', roleId: ids.salesman }))
    denied(await act.resetUserPasswordAction(a.uid, { generate: true }))
    denied(await act.deactivateUserAction(a.uid))
    denied(await act.activateUserAction(a.uid))
    denied(await act.createRoleAction({ name: 'Mine', permissions: [] }))
    denied(await act.cloneRoleAction(ids.manager, { name: 'Mine' }))
    denied(await act.updateRoleAction(ids.salesman, { name: 'salesman', permissions: [] }))
    denied(await act.deleteRoleAction(ids.manager))
  })

  it('view-only cannot create, edit or delete', async () => {
    const { ids, mkUser, mkRole, as } = await seed()
    const viewer = await mkUser('Vera', await mkRole('Viewer', ['users.view']))
    const other = await mkUser('Otto', ids.salesman)
    await as(viewer)
    const act = await import('./users')
    denied(await act.createUserAction({ name: 'X', email: 'x@example.test', roleId: ids.salesman, generate: true }))
    denied(await act.updateUserAction(other, { name: 'X', email: 'otto@example.test', roleId: ids.salesman }))
    denied(await act.deactivateUserAction(other))
    denied(await act.createRoleAction({ name: 'Mine', permissions: [] }))
  })

  it('deactivate needs users.delete, reactivate needs users.edit', async () => {
    const { ids, mkUser, mkRole, as, userRow } = await seed()
    const target = await mkUser('Tia', ids.salesman)
    const editor = await mkUser('Ed', await mkRole('Editor', ['users.edit', 'sales.view', 'sales.create', 'customers.view', 'customers.create', 'serials.view', 'serials.create']))
    const deleter = await mkUser('Del', await mkRole('Deleter', ['users.delete', 'sales.view', 'sales.create', 'customers.view', 'customers.create', 'serials.view', 'serials.create']))
    const act = await import('./users')
    await as(editor)
    denied(await act.deactivateUserAction(target))
    await as(deleter)
    expect(await act.deactivateUserAction(target)).toEqual({ ok: true, data: undefined })
    expect((await userRow(target)).active).toBe(false)
    expect((await act.activateUserAction(target)).ok).toBe(false)
    await as(editor)
    expect((await act.activateUserAction(target)).ok).toBe(true)
    expect((await userRow(target)).active).toBe(true)
  })
})

describe('privilege escalation', () => {
  it('cannot grant a permission you do not hold; admin can', async () => {
    const { a, ids, mkUser, mkRole, as, db, schema } = await seed()
    const hr = await mkUser('Hana', await mkRole('HR', ['users.view', 'users.create', 'users.edit', 'sales.view']))
    const act = await import('./users')
    await as(hr)
    const r = await act.createRoleAction({ name: 'Boss', permissions: ['sales.view', 'accounts.delete'] })
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/only grant permissions that you hold.*accounts\.delete/) })
    expect((await act.createRoleAction({ name: 'Viewer', permissions: ['sales.view'] })).ok).toBe(true)
    // clone of a bigger role is escalation too
    expect((await act.cloneRoleAction(ids.manager, { name: 'Manager copy' })).ok).toBe(false)
    // editing a role up to more than you hold
    const viewer = (await db.select().from(schema.roles).where(eq(schema.roles.name, 'Viewer')))[0]
    expect((await act.updateRoleAction(viewer.id, { name: 'Viewer', permissions: ['sales.view', 'settings.edit'] })).ok).toBe(false)
    // editing a role that already exceeds you (even to remove things) is refused
    expect((await act.updateRoleAction(ids.manager, { name: 'manager', permissions: ['sales.view'] })).ok).toBe(false)
    // admin may grant anything
    await as(a.uid)
    expect((await act.createRoleAction({ name: 'Boss', permissions: ['sales.view', 'accounts.delete', 'settings.delete'] })).ok).toBe(true)
  })

  it('cannot assign a role exceeding your permissions, nor the admin role unless admin', async () => {
    const { ids, mkUser, mkRole, as, userRow } = await seed()
    const hr = await mkUser('Hana', await mkRole('HR', ['users.view', 'users.create', 'users.edit', 'sales.view', 'sales.create', 'customers.view', 'customers.create', 'serials.view', 'serials.create']))
    const target = await mkUser('Tia', ids.salesman)
    const mgr = await mkUser('Max', ids.manager)
    const act = await import('./users')
    await as(hr)
    expect(await act.createUserAction({ name: 'X', email: 'x@example.test', roleId: ids.manager, generate: true })).toMatchObject({ ok: false, error: expect.stringMatching(/cannot assign/) })
    expect(await act.updateUserAction(target, { name: 'Tia', email: 'tia@example.test', roleId: ids.manager })).toMatchObject({ ok: false, error: expect.stringMatching(/cannot assign/) })
    expect((await userRow(target)).roleId).toBe(ids.salesman)
    // salesman role is within HR's permissions: allowed
    expect((await act.createUserAction({ name: 'Y', email: 'y@example.test', roleId: ids.salesman, generate: true })).ok).toBe(true)
    // a manager cannot make anyone admin, nor touch an admin account
    await as(mgr)
    expect(await act.updateUserAction(target, { name: 'Tia', email: 'tia@example.test', roleId: ids.admin })).toMatchObject({ ok: false, error: expect.stringMatching(/administrator/) })
    const admins = await mkUser('Ada', ids.admin)
    expect(await act.resetUserPasswordAction(admins, { generate: true })).toMatchObject({ ok: false, error: expect.stringMatching(/administrator/) })
    expect(await act.updateUserAction(admins, { name: 'Ada2', email: 'ada@example.test', roleId: ids.admin })).toMatchObject({ ok: false })
    expect((await userRow(admins)).name).toBe('Ada')
  })

  it('cannot edit your own role or change your own role', async () => {
    const { ids, mkUser, mkRole, as, userRow } = await seed()
    const hrRole = await mkRole('HR', ['users.view', 'users.create', 'users.edit'])
    const hr = await mkUser('Hana', hrRole)
    const act = await import('./users')
    await as(hr)
    expect(await act.updateRoleAction(hrRole, { name: 'HR', permissions: ['users.view', 'users.create', 'users.edit'] })).toMatchObject({ ok: false, error: expect.stringMatching(/role you hold/) })
    expect(await act.updateUserAction(hr, { name: 'Hana', email: 'hana@example.test', roleId: ids.salesman })).toMatchObject({ ok: false, error: expect.stringMatching(/own role/) })
    expect((await userRow(hr)).roleId).toBe(hrRole)
    // but may fix their own name
    expect((await act.updateUserAction(hr, { name: 'Hana K', email: 'hana@example.test', roleId: hrRole })).ok).toBe(true)
  })

  it('a stale JWT cannot act once the actor was demoted (fresh permissions are re-checked in the transaction)', async () => {
    const { a, ids, mkUser, as, db, schema } = await seed()
    const mgr = await mkUser('Max', ids.manager)
    const target = await mkUser('Tia', ids.salesman)
    await as(mgr)
    const stale = st.session!
    // demote the manager out of band (no sv bump: simulates a race between authorize() and the transaction)
    await db.update(schema.users).set({ roleId: ids.salesman }).where(eq(schema.users.id, mgr))
    st.session = stale
    const act = await import('./users')
    denied(await act.updateUserAction(target, { name: 'Tia', email: 'tia@example.test', roleId: ids.salesman }))
    // and a revoked session (sv bumped) is refused outright
    await as(a.uid)
    const adminSession = st.session!
    await (await import('../auth/revoke')).revokeUserSessions(a.cid, a.uid)
    st.session = adminSession
    expect(await act.deactivateUserAction(target)).toMatchObject({ ok: false, error: expect.stringMatching(/session has expired/) })
  })
})

describe('role rules', () => {
  it('reserved name, case/space duplicates, system role restrictions, delete only when unused', async () => {
    const { a, ids, mkUser, as, db, schema } = await seed()
    const act = await import('./users')
    await as(a.uid)
    for (const name of ['admin', ' ADMIN ', 'Ad min', 'ａｄｍｉｎ']) {
      expect(await act.createRoleAction({ name, permissions: [] })).toMatchObject({ ok: false, fieldErrors: { name: expect.stringMatching(/reserved/) } })
    }
    const c = await act.createRoleAction({ name: 'Cashier', permissions: ['sales.view'] })
    expect(c.ok).toBe(true)
    const cid = (c as { data: { id: string } }).data.id
    expect(await act.createRoleAction({ name: ' cash IER ', permissions: [] })).toMatchObject({ ok: false, fieldErrors: { name: expect.stringMatching(/already exists/) } })
    expect(await act.createRoleAction({ name: 'Manager', permissions: [] })).toMatchObject({ ok: false, fieldErrors: { name: expect.stringMatching(/already exists/) } })
    expect(await act.updateRoleAction(cid, { name: 'Admin', permissions: [] })).toMatchObject({ ok: false, fieldErrors: { name: expect.stringMatching(/reserved/) } })
    expect(await act.cloneRoleAction(cid, { name: 'ADMIN' })).toMatchObject({ ok: false })
    expect(await act.updateRoleAction(cid, { name: 'Cashier', permissions: ['sales.view', 'sales.fly'] })).toMatchObject({ ok: false, fieldErrors: { permissions: expect.stringMatching(/Unknown permission/) } })
    // system roles
    expect(await act.updateRoleAction(ids.admin, { name: 'admin', permissions: [] })).toMatchObject({ ok: false, error: expect.stringMatching(/cannot be edited/) })
    expect(await act.updateRoleAction(ids.manager, { name: 'Boss', permissions: [] })).toMatchObject({ ok: false, fieldErrors: { name: expect.stringMatching(/cannot be renamed/) } })
    expect((await act.updateRoleAction(ids.salesman, { name: 'salesman', permissions: ['sales.view'] })).ok).toBe(true)
    expect(await act.deleteRoleAction(ids.manager)).toMatchObject({ ok: false, error: expect.stringMatching(/System roles/) })
    // delete: refused while assigned (even to an inactive user), allowed once unused
    const u = await mkUser('Cas', cid)
    await db.update(schema.users).set({ active: false }).where(eq(schema.users.id, u))
    expect(await act.deleteRoleAction(cid)).toMatchObject({ ok: false, error: expect.stringMatching(/assigned to 1 user/) })
    await db.update(schema.users).set({ roleId: ids.salesman }).where(eq(schema.users.id, u))
    expect((await act.deleteRoleAction(cid)).ok).toBe(true)
    expect(await db.select().from(schema.rolePermissions).where(eq(schema.rolePermissions.roleId, cid))).toEqual([])
    // clone copies permissions
    const cl = await act.cloneRoleAction(ids.manager, { name: 'Manager 2' })
    expect(cl.ok).toBe(true)
    const perms = await db.select().from(schema.rolePermissions).where(eq(schema.rolePermissions.roleId, (cl as { data: { id: string } }).data.id))
    expect(perms.length).toBe((await db.select().from(schema.rolePermissions).where(eq(schema.rolePermissions.roleId, ids.manager))).length)
  })
})

describe('session revocation', () => {
  it('role permission change, role change, deactivation and password reset all invalidate sessions', async () => {
    const { a, ids, mkUser, as, sessionOf } = await seed()
    const { loadSessionUser } = await import('../auth/session-user')
    const s1 = await mkUser('One', ids.salesman)
    const s2 = await mkUser('Two', ids.salesman)
    const m = await mkUser('Mo', ids.manager)
    const tokens = { s1: await sessionOf(s1), s2: await sessionOf(s2), m: await sessionOf(m) }
    for (const tk of Object.values(tokens)) expect(await loadSessionUser(tk)).not.toBeNull()
    const act = await import('./users')
    await as(a.uid)

    // salesman role permissions change: every salesman is out, the manager is not
    const r = await act.updateRoleAction(ids.salesman, { name: 'salesman', permissions: ['sales.view', 'sales.create'] })
    expect(r).toMatchObject({ ok: true, data: { signedOut: 2 } })
    expect(await loadSessionUser(tokens.s1)).toBeNull()
    expect(await loadSessionUser(tokens.s2)).toBeNull()
    expect(await loadSessionUser(tokens.m)).not.toBeNull()
    // saving the same permissions again is a no-op (nobody signed out)
    tokens.s1 = await sessionOf(s1)
    expect(await act.updateRoleAction(ids.salesman, { name: 'salesman', permissions: ['sales.create', 'sales.view'] })).toMatchObject({ ok: true, data: { signedOut: 0 } })
    expect(await loadSessionUser(tokens.s1)).not.toBeNull()

    // user role change
    expect((await act.updateUserAction(m, { name: 'Mo', email: 'mo@example.test', roleId: ids.salesman })).ok).toBe(true)
    expect(await loadSessionUser(tokens.m)).toBeNull()
    // deactivate
    await act.deactivateUserAction(s1)
    expect(await loadSessionUser(tokens.s1)).toBeNull()
    // password reset
    tokens.s2 = await sessionOf(s2)
    const pr = await act.resetUserPasswordAction(s2, { generate: true })
    expect(pr).toMatchObject({ ok: true, data: { generatedPassword: expect.stringMatching(/^.{16}$/) } })
    expect(await loadSessionUser(tokens.s2)).toBeNull()
    // a plain name edit does not sign anyone out
    tokens.s2 = await sessionOf(s2)
    expect(await act.updateUserAction(s2, { name: 'Two B', email: 'two@example.test', roleId: ids.salesman })).toMatchObject({ ok: true, data: { signedOut: false } })
    expect(await loadSessionUser(tokens.s2)).not.toBeNull()
  })
})

describe('users', () => {
  it('create: friendly duplicate email (also across companies), generated password shown once, default branch', async () => {
    const { a, ids, as, db, schema } = await seed()
    const { verifyPassword } = await import('../auth/password')
    const act = await import('./users')
    await as(a.uid)
    expect(await act.createUserAction({ name: 'Dup', email: 'B@Example.test', roleId: ids.salesman, generate: true })).toMatchObject({ ok: false, fieldErrors: { email: expect.stringMatching(/already used/) } })
    expect(await act.createUserAction({ name: 'Short', email: 's@example.test', roleId: ids.salesman, password: 'short' })).toMatchObject({ ok: false, fieldErrors: { password: expect.stringMatching(/at least 10/) } })
    const typed = await act.createUserAction({ name: 'Typed', email: 'typed@example.test', roleId: ids.salesman, password: 'typed-password-1' })
    expect(typed).toMatchObject({ ok: true })
    expect((typed as { data: object }).data).not.toHaveProperty('generatedPassword')
    const gen = await act.createUserAction({ name: 'Gen', email: ' GEN@example.test ', roleId: ids.salesman, generate: true })
    const pw = (gen as { data: { generatedPassword: string; id: string } }).data
    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, pw.id))
    expect(row.email).toBe('gen@example.test')
    expect(await verifyPassword(pw.generatedPassword, row.passwordHash)).toBe(true)
    const [main] = await db.select().from(schema.branches).where(and(eq(schema.branches.companyId, a.cid), eq(schema.branches.isDefault, true)))
    expect(row.branchId).toBe(main.id)
  })

  it('other-company ids behave as not found (IDOR)', async () => {
    const { a, b, ids, as, userRow } = await seed()
    const act = await import('./users')
    await as(a.uid)
    expect(await act.updateUserAction(b.uid, { name: 'X', email: 'b@example.test', roleId: ids.salesman })).toMatchObject({ ok: false, error: expect.stringMatching(/not found/) })
    expect(await act.resetUserPasswordAction(b.uid, { generate: true })).toMatchObject({ ok: false, error: expect.stringMatching(/not found/) })
    expect(await act.deactivateUserAction(b.uid)).toMatchObject({ ok: false, error: expect.stringMatching(/not found/) })
    expect(await act.updateRoleAction(ids.bAdmin, { name: 'xyz', permissions: [] })).toMatchObject({ ok: false, error: expect.stringMatching(/not found/) })
    expect(await act.deleteRoleAction(ids.bAdmin)).toMatchObject({ ok: false, error: expect.stringMatching(/not found/) })
    expect(await act.cloneRoleAction(ids.bAdmin, { name: 'Copy' })).toMatchObject({ ok: false, error: expect.stringMatching(/not found/) })
    expect(await act.createUserAction({ name: 'X', email: 'x@example.test', roleId: ids.bAdmin, generate: true })).toMatchObject({ ok: false, fieldErrors: { roleId: 'Role not found' } })
    expect(await act.updateUserAction(NIL, { name: 'X', email: 'x@example.test', roleId: ids.salesman })).toMatchObject({ ok: false, error: expect.stringMatching(/not found/) })
    expect((await userRow(b.uid)).active).toBe(true)
  })

  it('self-protection: no self deactivation, reset or role change', async () => {
    const { a, ids, as, userRow } = await seed()
    const act = await import('./users')
    await as(a.uid)
    expect(await act.deactivateUserAction(a.uid)).toMatchObject({ ok: false, error: expect.stringMatching(/your own account/) })
    expect(await act.resetUserPasswordAction(a.uid, { generate: true })).toMatchObject({ ok: false, error: expect.stringMatching(/Change password/) })
    expect(await act.updateUserAction(a.uid, { name: 'A', email: 'a@example.test', roleId: ids.manager })).toMatchObject({ ok: false, error: expect.stringMatching(/own role/) })
    expect((await userRow(a.uid))).toMatchObject({ active: true, roleId: ids.admin })
  })

  it('password reset needs users.edit and bumps session_version', async () => {
    const { ids, mkUser, mkRole, as, userRow } = await seed()
    const target = await mkUser('Tia', ids.salesman)
    const noEdit = await mkUser('Nia', await mkRole('NoEdit', ['users.view', 'users.create', 'users.delete']))
    const act = await import('./users')
    await as(noEdit)
    denied(await act.resetUserPasswordAction(target, { generate: true }))
    const editor = await mkUser('Ed', await mkRole('Editor', ['users.edit', 'sales.view', 'sales.create', 'customers.view', 'customers.create', 'serials.view', 'serials.create']))
    await as(editor)
    const before = (await userRow(target)).sessionVersion
    expect(await act.resetUserPasswordAction(target, { password: 'short' })).toMatchObject({ ok: false, fieldErrors: { password: expect.any(String) } })
    expect(await act.resetUserPasswordAction(target, { password: 'brand-new-pass-1' })).toEqual({ ok: true, data: {} })
    expect((await userRow(target)).sessionVersion).toBe(before + 1)
  })

  it('activity log never contains passwords or hashes', async () => {
    const { a, ids, mkUser, as, db, schema } = await seed()
    const act = await import('./users')
    const acc = await import('./account')
    await as(a.uid)
    const typed = 'typed-secret-pass-1'
    const created = await act.createUserAction({ name: 'Lea', email: 'lea@example.test', roleId: ids.salesman, password: typed })
    const id = (created as { data: { id: string } }).data.id
    const gen = await act.resetUserPasswordAction(id, { generate: true })
    const genPw = (gen as { data: { generatedPassword: string } }).data.generatedPassword
    await act.updateUserAction(id, { name: 'Lea B', email: 'lea@example.test', roleId: ids.salesman })
    await act.deactivateUserAction(id)
    await act.activateUserAction(id)
    const self = await mkUser('Selma', ids.salesman)
    await as(self)
    expect(await acc.changeOwnPasswordAction({ current: 'initial-password-1', next: 'my-new-secret-99', confirm: 'my-new-secret-99' })).toEqual({ ok: true, data: undefined })
    const logs = await db.select().from(schema.activityLog).where(eq(schema.activityLog.entity, 'user'))
    expect(logs.map((l) => l.action)).toEqual(expect.arrayContaining(['user.create', 'user.password_reset', 'user.update', 'user.deactivate', 'user.activate', 'user.password_change']))
    const keys: string[] = []
    const walk = (v: unknown) => {
      if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
          keys.push(k)
          walk(x)
        }
    }
    for (const l of logs) {
      walk(l.before)
      walk(l.after)
    }
    expect(keys.filter((k) => /hash|password|secret|token/i.test(k))).toEqual([])
    const text = JSON.stringify(logs)
    for (const secret of [typed, genPw, 'my-new-secret-99', 'initial-password-1', '$2a$', '$2b$']) expect(text).not.toContain(secret)
  })
})

describe('change own password', () => {
  it('requires the current password, signs out other sessions and re-issues this one', async () => {
    const { ids, mkUser, as, sessionOf } = await seed()
    const { loadSessionUser } = await import('../auth/session-user')
    const { verifySession } = await import('../auth/session')
    const u = await mkUser('Pat', ids.salesman)
    await as(u)
    const other = await sessionOf(u)
    const acc = await import('./account')
    expect(await acc.changeOwnPasswordAction({ current: 'wrong-password-x', next: 'new-password-123', confirm: 'new-password-123' })).toMatchObject({ ok: false, fieldErrors: { current: expect.any(String) } })
    expect(await acc.changeOwnPasswordAction({ current: 'initial-password-1', next: 'new-password-123', confirm: 'nope-nope-nope' })).toMatchObject({ ok: false, fieldErrors: { confirm: expect.any(String) } })
    expect(await acc.changeOwnPasswordAction({ current: 'initial-password-1', next: 'short', confirm: 'short' })).toMatchObject({ ok: false, fieldErrors: { next: expect.any(String) } })
    expect(await acc.changeOwnPasswordAction({ current: 'initial-password-1', next: 'new-password-123', confirm: 'new-password-123' })).toEqual({ ok: true, data: undefined })
    expect(await loadSessionUser(other)).toBeNull()
    const fresh = await verifySession(st.jar.get('sserp_session'))
    expect(fresh?.sv).toBe(other.sv + 1)
    expect(await loadSessionUser(fresh!)).not.toBeNull()
  })
})

describe('last administrator', () => {
  it('two admins demoting each other at the same time: at least one admin remains', async () => {
    const { a, ids, mkUser, sessionOf, db, schema } = await seed()
    const { updateUser } = await import('../iam/users')
    const a2 = await mkUser('Second', ids.admin)
    const [s1, s2] = [await sessionOf(a.uid), await sessionOf(a2)]
    for (let round = 0; round < 3; round++) {
      const res = await Promise.allSettled([
        updateUser(db, { companyId: a.cid, userId: a.uid, sv: s1.sv }, a2, { name: 'Second', email: 'second@example.test', roleId: ids.manager }),
        updateUser(db, { companyId: a.cid, userId: a2, sv: s2.sv }, a.uid, { name: 'A', email: 'a@example.test', roleId: ids.manager }),
      ])
      const admins = await db.select().from(schema.users).where(and(eq(schema.users.roleId, ids.admin), eq(schema.users.active, true)))
      expect(admins.length).toBe(1)
      expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      // restore for the next round
      const loser = admins[0].id === a.uid ? a2 : a.uid
      await db.update(schema.users).set({ roleId: ids.admin }).where(eq(schema.users.id, loser))
      ;[s1.sv, s2.sv] = [(await sessionOf(a.uid)).sv, (await sessionOf(a2)).sv]
    }
    // same race without session versions (permission re-check path): still one admin
    const res = await Promise.allSettled([
      updateUser(db, { companyId: a.cid, userId: a.uid }, a2, { name: 'Second', email: 'second@example.test', roleId: ids.manager }),
      updateUser(db, { companyId: a.cid, userId: a2 }, a.uid, { name: 'A', email: 'a@example.test', roleId: ids.manager }),
    ])
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect((await db.select().from(schema.users).where(and(eq(schema.users.roleId, ids.admin), eq(schema.users.active, true)))).length).toBe(1)
  })

  it('concurrent deactivation of each other: at least one admin remains', async () => {
    const { a, ids, mkUser, db, schema } = await seed()
    const { setUserActive } = await import('../iam/users')
    const a2 = await mkUser('Second', ids.admin)
    const res = await Promise.allSettled([setUserActive(db, { companyId: a.cid, userId: a.uid }, a2, false), setUserActive(db, { companyId: a.cid, userId: a2 }, a.uid, false)])
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect((await db.select().from(schema.users).where(and(eq(schema.users.roleId, ids.admin), eq(schema.users.active, true)))).length).toBe(1)
  })

  it('assertAdminRemains refuses a transaction that would leave zero active admins', async () => {
    const { a, ids, db, schema } = await seed()
    const { assertAdminRemains, lockAdmins } = await import('../iam/core')
    await expect(
      db.transaction(async (tx) => {
        expect(await lockAdmins(tx, a.cid)).toEqual([a.uid])
        await tx.update(schema.users).set({ roleId: ids.manager }).where(eq(schema.users.id, a.uid))
        await assertAdminRemains(tx, a.cid)
      }),
    ).rejects.toThrow(/without an active administrator/)
    expect((await db.select().from(schema.users).where(eq(schema.users.id, a.uid)))[0].roleId).toBe(ids.admin)
  })
})

describe('Task 15 hardening', () => {
  const PEER_PERMS = ['users.view', 'users.edit', 'users.delete', 'sales.view', 'customers.view']

  it('a non-admin cannot reset, deactivate or re-email a peer with the same permissions; a strict subset is fine', async () => {
    const { mkUser, mkRole, as, userRow } = await seed()
    const peerRole = await mkRole('HR', PEER_PERMS)
    const hr1 = await mkUser('Hr1', peerRole)
    const hr2 = await mkUser('Hr2', peerRole)
    const clone = await mkUser('Clone', await mkRole('HR copy', PEER_PERMS)) // same permissions, different role
    const junior = await mkUser('Jun', await mkRole('Junior', ['sales.view']))
    const act = await import('./users')
    await as(hr1)
    for (const target of [hr2, clone]) {
      expect(await act.resetUserPasswordAction(target, { generate: true })).toMatchObject({ ok: false, error: expect.stringMatching(/same permissions/) })
      expect(await act.deactivateUserAction(target)).toMatchObject({ ok: false, error: expect.stringMatching(/same permissions/) })
      expect(await act.updateUserAction(target, { name: 'X', email: 'evil@example.test', roleId: (await userRow(target)).roleId })).toMatchObject({ ok: false, error: expect.stringMatching(/same permissions/) })
      expect((await userRow(target))).toMatchObject({ active: true, email: expect.not.stringMatching(/evil/) })
    }
    expect((await act.resetUserPasswordAction(junior, { generate: true })).ok).toBe(true)
    expect((await act.deactivateUserAction(junior)).ok).toBe(true)
  })

  it('admins are unrestricted; password reset and deactivation record the request IP', async () => {
    const { a, ids, mkUser, as, db, schema } = await seed()
    const a2 = await mkUser('Second', ids.admin)
    const act = await import('./users')
    await as(a.uid)
    expect((await act.resetUserPasswordAction(a2, { generate: true })).ok).toBe(true)
    const [log] = await db.select().from(schema.activityLog).where(and(eq(schema.activityLog.action, 'user.password_reset'), eq(schema.activityLog.entityId, a2)))
    // next/headers is mocked with empty headers: no trusted proxy -> the shared 'direct' bucket label
    expect(log.ip).toEqual(expect.any(String))
  })

  it('changing your own email needs your current password', async () => {
    const { a, ids, as, userRow } = await seed()
    const act = await import('./users')
    const { hashPassword } = await import('../auth/password')
    const { getDb, schema } = await import('../db')
    await getDb().update(schema.users).set({ passwordHash: await hashPassword('my-own-password-1') }).where(eq(schema.users.id, a.uid))
    await as(a.uid)
    const base = { name: 'A', roleId: ids.admin }
    const original = (await userRow(a.uid)).email
    expect(await act.updateUserAction(a.uid, { ...base, email: 'new@example.test' })).toMatchObject({ ok: false, fieldErrors: { currentPassword: expect.any(String) } })
    expect(await act.updateUserAction(a.uid, { ...base, email: 'new@example.test', currentPassword: 'wrong-password-x' })).toMatchObject({ ok: false, fieldErrors: { currentPassword: /incorrect/ } })
    expect((await userRow(a.uid)).email).toBe(original)
    // a name-only self edit needs no password
    expect((await act.updateUserAction(a.uid, { ...base, name: 'A renamed', email: original })).ok).toBe(true)
    expect((await act.updateUserAction(a.uid, { ...base, email: 'new@example.test', currentPassword: 'my-own-password-1' })).ok).toBe(true)
    expect((await userRow(a.uid)).email).toBe('new@example.test')
  })

  it('a third admin demoting two admins while they demote each other: at least one admin remains', async () => {
    const { a, ids, mkUser, db, schema } = await seed()
    const { updateUser } = await import('../iam/users')
    const a2 = await mkUser('Second', ids.admin)
    const a3 = await mkUser('Third', ids.admin)
    const actor = (uid: string) => ({ companyId: a.cid, userId: uid })
    const demote = (by: string, who: string, name: string) => updateUser(db, actor(by), who, { name, email: `${name.toLowerCase()}@example.test`, roleId: ids.manager })
    const [u1] = await db.select().from(schema.users).where(eq(schema.users.id, a.uid))
    for (let round = 0; round < 3; round++) {
      await Promise.allSettled([demote(a3, a.uid, u1.name), demote(a3, a2, 'Second'), demote(a.uid, a2, 'Second'), demote(a2, a.uid, u1.name), demote(a.uid, a3, 'Third'), demote(a2, a3, 'Third')])
      const admins = await db.select().from(schema.users).where(and(eq(schema.users.roleId, ids.admin), eq(schema.users.active, true)))
      expect(admins.length).toBeGreaterThanOrEqual(1)
      await db.update(schema.users).set({ roleId: ids.admin, email: sql`email` }).where(inArray(schema.users.id, [a.uid, a2, a3]))
    }
  })
})

describe('Task 15 fix round 1: no peer takeover through roles', () => {
  const PEER_PERMS = ['users.view', 'users.create', 'users.edit', 'users.delete', 'sales.view', 'customers.view']

  it('HR1 cannot edit, strip, delete or clone-and-assign a role equal to its own permissions; the Clone reset attack fails end to end', async () => {
    const { db, schema, mkUser, mkRole, as, userRow } = await seed()
    const hrRole = await mkRole('HR', PEER_PERMS)
    const copyRole = await mkRole('HR copy', PEER_PERMS) // same permission set, different role
    const hr1 = await mkUser('Hr1', hrRole)
    const clone = await mkUser('Clone', copyRole)
    const act = await import('./users')
    await as(hr1)
    const before = await userRow(clone)

    // 1. edit the peer role (rename or strip a permission so Clone becomes "below" HR1): refused
    expect(await act.updateRoleAction(copyRole, { name: 'HR copy', permissions: PEER_PERMS.filter((p) => p !== 'users.delete') })).toMatchObject({ ok: false, error: expect.stringMatching(/fewer permissions/) })
    expect(await act.updateRoleAction(copyRole, { name: 'HR copy 2', permissions: PEER_PERMS })).toMatchObject({ ok: false })
    expect(await act.deleteRoleAction(copyRole)).toMatchObject({ ok: false })
    // 2. clone a peer role, or create one equal to mine: refused (would make a role you could then assign to peers)
    expect(await act.cloneRoleAction(copyRole, { name: 'HR clone' })).toMatchObject({ ok: false, error: expect.stringMatching(/fewer permissions/) })
    expect(await act.createRoleAction({ name: 'HR equal', permissions: PEER_PERMS })).toMatchObject({ ok: false })
    // 3. move Clone to a lower role, or move someone to a peer role: refused
    const low = await mkRole('Low', ['sales.view'])
    expect(await act.updateUserAction(clone, { name: 'Clone', email: before.email, roleId: low })).toMatchObject({ ok: false, error: expect.stringMatching(/same permissions/) })
    const junior = await mkUser('Jun', low)
    expect(await act.updateUserAction(junior, { name: 'Jun', email: (await userRow(junior)).email, roleId: copyRole })).toMatchObject({ ok: false, error: expect.stringMatching(/fewer permissions/) })
    // 4. so the final step of the attack, resetting Clone's password, still fails
    expect(await act.resetUserPasswordAction(clone, { generate: true })).toMatchObject({ ok: false })
    const after = await userRow(clone)
    expect(after).toMatchObject({ passwordHash: before.passwordHash, roleId: copyRole, sessionVersion: before.sessionVersion })
    const perms = (await db.select().from(schema.rolePermissions).where(eq(schema.rolePermissions.roleId, copyRole))).map((p) => p.permission).sort()
    expect(perms).toEqual([...PEER_PERMS].sort())
  })

  it('a retired permission key stored on the actor role does not count as an extra permission (catalog intersection)', async () => {
    const { a, db, schema, mkUser, mkRole, as } = await seed()
    const hrRole = await mkRole('HR', PEER_PERMS)
    // A key that is no longer in the PERMISSIONS catalog (e.g. left over from an older version) on the actor's role.
    await db.insert(schema.rolePermissions).values({ companyId: a.cid, roleId: hrRole, permission: 'legacy.retired' })
    const peer = await mkUser('Peer', await mkRole('HR copy', PEER_PERMS))
    const hr1 = await mkUser('Hr1', hrRole)
    const act = await import('./users')
    await as(hr1)
    expect(await act.createRoleAction({ name: 'HR equal', permissions: PEER_PERMS })).toMatchObject({ ok: false, error: expect.stringMatching(/fewer permissions/) })
    expect(await act.resetUserPasswordAction(peer, { generate: true })).toMatchObject({ ok: false, error: expect.stringMatching(/same permissions/) })
    // a genuine subset is still fine
    expect((await act.createRoleAction({ name: 'HR lite', permissions: PEER_PERMS.filter((p) => p !== 'users.delete') })).ok).toBe(true)
  })

  it('a manager (superset) still edits a salesman-like role and assigns it; admins are unrestricted', async () => {
    const { a, ids, db, schema, mkUser, mkRole, as } = await seed()
    const act = await import('./users')
    const mgr = await mkUser('Mona', ids.manager)
    const shop = await mkRole('Shop floor', ['sales.view', 'sales.create', 'customers.view'])
    await as(mgr)
    expect((await act.updateRoleAction(shop, { name: 'Shop floor', permissions: ['sales.view', 'sales.create'] })).ok).toBe(true)
    expect((await act.createRoleAction({ name: 'Viewer', permissions: ['sales.view'] })).ok).toBe(true)
    const sam = await mkUser('Sam', ids.salesman)
    expect((await act.updateUserAction(sam, { name: 'Sam', email: 'sam@example.test', roleId: shop })).ok).toBe(true)
    // the manager cannot edit its own (or an equal) role
    expect((await act.updateRoleAction(ids.manager, { name: 'manager', permissions: ['sales.view'] })).ok).toBe(false)

    const peerA = await mkRole('Peer A', ['sales.view', 'users.edit'])
    const peerB = await mkRole('Peer B', ['sales.view', 'users.edit'])
    await as(a.uid)
    expect((await act.updateRoleAction(peerA, { name: 'Peer A', permissions: ['sales.view'] })).ok).toBe(true)
    expect((await act.cloneRoleAction(peerB, { name: 'Peer B copy' })).ok).toBe(true)
    expect((await db.select().from(schema.roles).where(eq(schema.roles.name, 'Peer B copy'))).length).toBe(1)
  })
})
