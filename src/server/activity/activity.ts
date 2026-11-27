/**
 * Read side of activity_log (Activity Log page, permission activity.view) and record_history (per-record History drawer).
 * Everything is scoped by company id; user names are joined only within the same company.
 */
import { and, asc, count, desc, eq, gte, ilike, lt, or, sql } from 'drizzle-orm'
import { schema, type Db } from '../db'
import { likePattern } from '../pagination'
import type { Permission } from '../rbac'
import { isIsoDate } from '../reports/pure'

export type ActivityFilter = { userId?: string; entity?: string; action?: string; from?: string; to?: string; q?: string; tz: string; limit: number; offset: number }

export type ActivityRow = { id: string; createdAt: Date; userId: string | null; userName: string | null; userEmail: string | null; action: string; entity: string; entityId: string | null; before: unknown; after: unknown; ip: string | null }

/** `from`/`to` are calendar dates in the shop's time zone (inclusive). */
export async function listActivity(db: Pick<Db, 'select'>, companyId: string, f: ActivityFilter): Promise<{ rows: ActivityRow[]; total: number }> {
  const l = schema.activityLog
  const u = schema.users
  const where = and(
    eq(l.companyId, companyId),
    f.userId ? eq(l.userId, f.userId) : undefined,
    f.entity ? eq(l.entity, f.entity) : undefined,
    f.action ? ilike(l.action, likePattern(f.action)) : undefined,
    f.from && isIsoDate(f.from) ? gte(l.createdAt, sql`(${f.from}::date)::timestamp at time zone ${f.tz}`) : undefined,
    f.to && isIsoDate(f.to) ? lt(l.createdAt, sql`((${f.to}::date) + 1)::timestamp at time zone ${f.tz}`) : undefined,
    f.q ? or(ilike(l.action, likePattern(f.q)), ilike(l.entity, likePattern(f.q)), ilike(l.entityId, likePattern(f.q)), ilike(u.name, likePattern(f.q)), ilike(u.email, likePattern(f.q))) : undefined,
  )
  const [rows, [{ n }]] = await Promise.all([
    db
      .select({ id: l.id, createdAt: l.createdAt, userId: l.userId, userName: u.name, userEmail: u.email, action: l.action, entity: l.entity, entityId: l.entityId, before: l.before, after: l.after, ip: l.ip })
      .from(l)
      .leftJoin(u, and(eq(u.id, l.userId), eq(u.companyId, companyId)))
      .where(where)
      .orderBy(desc(l.createdAt), desc(l.id))
      .limit(f.limit)
      .offset(f.offset),
    db.select({ n: count() }).from(l).leftJoin(u, and(eq(u.id, l.userId), eq(u.companyId, companyId))).where(where),
  ])
  return { rows, total: Number(n) }
}

/** Filter choices: the company's users and the entity names present in its log. */
export async function activityFilterOptions(db: Pick<Db, 'select' | 'selectDistinct'>, companyId: string) {
  const [users, entities] = await Promise.all([
    db.select({ id: schema.users.id, name: schema.users.name, email: schema.users.email }).from(schema.users).where(eq(schema.users.companyId, companyId)).orderBy(asc(schema.users.name)),
    db.selectDistinct({ entity: schema.activityLog.entity }).from(schema.activityLog).where(eq(schema.activityLog.companyId, companyId)).orderBy(asc(schema.activityLog.entity)).limit(200),
  ])
  return { users, entities: entities.map((e) => e.entity) }
}

/**
 * Entities with a History drawer and the permission needed to read their history (the same one that shows the record).
 * Unknown entities have no history access at all.
 */
export const HISTORY_PERMISSION: Readonly<Record<string, Permission>> = {
  product: 'products.view',
  vendor: 'vendors.view',
  customer: 'customers.view',
  purchase: 'purchases.view',
  sale: 'sales.view',
  account: 'accounts.view',
  expense: 'accounts.view',
  income: 'accounts.view',
  settings: 'settings.view',
  role: 'users.view',
  branch: 'settings.view',
}

export const historyPermission = (entity: string): Permission | null => (Object.hasOwn(HISTORY_PERMISSION, entity) ? HISTORY_PERMISSION[entity] : null)

export type HistoryRow = { id: string; createdAt: Date; changedByName: string | null; diff: unknown }

export async function getRecordHistory(db: Pick<Db, 'select'>, companyId: string, entity: string, entityId: string, limit = 100): Promise<HistoryRow[]> {
  const h = schema.recordHistory
  return db
    .select({ id: h.id, createdAt: h.createdAt, changedByName: schema.users.name, diff: h.diff })
    .from(h)
    .leftJoin(schema.users, and(eq(schema.users.id, h.changedBy), eq(schema.users.companyId, companyId)))
    .where(and(eq(h.companyId, companyId), eq(h.entity, entity), eq(h.entityId, entityId)))
    .orderBy(desc(h.createdAt), desc(h.id))
    .limit(limit)
}
