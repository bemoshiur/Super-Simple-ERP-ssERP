/** DB-test seeding: company A through the real installer, company B inserted directly (the installer runs once per database). */
export async function seedTwoCompanies() {
  const { seedBase } = await import('../server/install')
  const { getDb, schema } = await import('../server/db')
  const a = await seedBase({ companyName: 'A Co', adminName: 'A', adminEmail: 'a@example.test', adminPassword: 'password-a-1234' })
  const db = getDb()
  const [cb] = await db.insert(schema.companies).values({ name: 'B Co' }).returning()
  const [mb] = await db.insert(schema.branches).values({ companyId: cb.id, name: 'Main', code: 'MAIN', isDefault: true }).returning()
  const [rb] = await db.insert(schema.roles).values({ companyId: cb.id, name: 'admin', isSystem: true }).returning()
  const [ub] = await db.insert(schema.users).values({ companyId: cb.id, branchId: mb.id, roleId: rb.id, name: 'B', email: 'b@example.test', passwordHash: 'x' }).returning()
  return { a: { cid: a.companyId, uid: a.adminUserId }, b: { cid: cb.id, uid: ub.id } }
}

/** The company's default (Main) branch id: rows inserted directly by tests must carry it (Task 14: stock is per branch). */
export async function mainBranchId(companyId: string): Promise<string> {
  const { getDb, schema } = await import('../server/db')
  const { and, eq } = await import('drizzle-orm')
  const [row] = await getDb().select({ id: schema.branches.id }).from(schema.branches).where(and(eq(schema.branches.companyId, companyId), eq(schema.branches.isDefault, true)))
  if (!row) throw new Error('company has no default branch')
  return row.id
}

/** Write context for data-layer calls made directly by tests: the company's Main branch, unrestricted. */
export async function mainCtx(companyId: string): Promise<{ branchId: string; restrict: null }> {
  return { branchId: await mainBranchId(companyId), restrict: null }
}
