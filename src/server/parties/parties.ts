import { and, asc, count, eq, ilike, or } from 'drizzle-orm'
import { logActivity } from '../audit'
import { schema, type Db } from '../db'
import { NotFoundError } from '../errors'
import { diffFields, writeHistory } from '../history'
import { likePattern } from '../pagination'
import { PARTY_TRACKED, partySchema, type PartyData } from './schemas'

export type PartyKind = 'vendor' | 'customer'
export type PartyStatus = 'active' | 'inactive' | 'all'

// vendors and customers have identical columns; one cast keeps the code generic.
const tableOf = (kind: PartyKind) => (kind === 'vendor' ? schema.vendors : schema.customers) as typeof schema.vendors
export type PartyRow = typeof schema.vendors.$inferSelect

const label = (k: PartyKind) => (k === 'vendor' ? 'Vendor' : 'Customer')
const snapshot = (d: PartyData | PartyRow) => ({ name: d.name, phone: d.phone, email: d.email, address: d.address, openingBalance: d.openingBalance, notes: d.notes })

/** Phone is deliberately NOT unique (shops share numbers, walk-in customers have none); only name is required. */
export async function createParty(db: Db, companyId: string, userId: string, kind: PartyKind, input: unknown): Promise<PartyRow> {
  const d = partySchema.parse(input)
  const t = tableOf(kind)
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(t).values({ companyId, ...snapshot(d) }).returning()
    await logActivity({ companyId, userId, action: `${kind}.create`, entity: kind, entityId: row.id, after: snapshot(d) }, tx)
    return row
  })
}

export async function getParty(db: Db, companyId: string, kind: PartyKind, id: string): Promise<PartyRow> {
  const t = tableOf(kind)
  const [row] = await db.select().from(t).where(and(eq(t.id, id), eq(t.companyId, companyId)))
  if (!row) throw new NotFoundError(label(kind))
  return row
}

export async function updateParty(db: Db, companyId: string, userId: string, kind: PartyKind, id: string, input: unknown): Promise<PartyRow> {
  const d = partySchema.parse(input)
  const t = tableOf(kind)
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(t).where(and(eq(t.id, id), eq(t.companyId, companyId))).for('update')
    if (!before) throw new NotFoundError(label(kind))
    const [row] = await tx.update(t).set({ ...snapshot(d), updatedAt: new Date() }).where(and(eq(t.id, id), eq(t.companyId, companyId))).returning()
    await writeHistory(tx, { companyId, userId, entity: kind, entityId: id, diff: diffFields(before, row, PARTY_TRACKED) })
    await logActivity({ companyId, userId, action: `${kind}.update`, entity: kind, entityId: id, before: snapshot(before), after: snapshot(d) }, tx)
    return row
  })
}

export async function setPartyActive(db: Db, companyId: string, userId: string, kind: PartyKind, id: string, active: boolean): Promise<PartyRow> {
  const t = tableOf(kind)
  return db.transaction(async (tx) => {
    const [row] = await tx.update(t).set({ active, updatedAt: new Date() }).where(and(eq(t.id, id), eq(t.companyId, companyId))).returning()
    if (!row) throw new NotFoundError(label(kind))
    await logActivity({ companyId, userId, action: `${kind}.${active ? 'activate' : 'deactivate'}`, entity: kind, entityId: id, after: { active } }, tx)
    return row
  })
}

export async function listParties(db: Db, companyId: string, kind: PartyKind, f: { q?: string; status?: PartyStatus; limit: number; offset: number }) {
  const t = tableOf(kind)
  const where = and(
    eq(t.companyId, companyId),
    f.q ? or(ilike(t.name, likePattern(f.q)), ilike(t.phone, likePattern(f.q)), ilike(t.email, likePattern(f.q))) : undefined,
    f.status === 'inactive' ? eq(t.active, false) : f.status === 'all' ? undefined : eq(t.active, true),
  )
  const [rows, [{ n }]] = await Promise.all([db.select().from(t).where(where).orderBy(asc(t.name)).limit(f.limit).offset(f.offset), db.select({ n: count() }).from(t).where(where)])
  return { rows, total: Number(n) }
}

/** Picker loader: active parties only, hard-capped at 20. */
export async function searchParties(db: Db, companyId: string, kind: PartyKind, q: string, limit = 20) {
  const t = tableOf(kind)
  const rows = await db
    .select({ id: t.id, name: t.name, phone: t.phone })
    .from(t)
    .where(and(eq(t.companyId, companyId), eq(t.active, true), q ? or(ilike(t.name, likePattern(q.slice(0, 100))), ilike(t.phone, likePattern(q.slice(0, 100)))) : undefined))
    .orderBy(asc(t.name))
    .limit(Math.min(Math.max(limit, 1), 20))
  return rows.map((r) => ({ value: r.id, label: r.name, description: r.phone ?? undefined }))
}
