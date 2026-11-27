import { boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { createdAt, id, updatedAt } from './_common'
import { branchId, companyId } from './core'

export const roles = pgTable(
  'roles',
  {
    id: id(),
    companyId: companyId(),
    name: text('name').notNull(),
    isSystem: boolean('is_system').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('roles_company_name_uq').on(t.companyId, t.name)],
)

export const rolePermissions = pgTable(
  'role_permissions',
  {
    companyId: companyId(),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permission: text('permission').notNull(), // 'module.action'
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permission] }), index('role_permissions_company_idx').on(t.companyId)],
)

export const users = pgTable(
  'users',
  {
    id: id(),
    companyId: companyId(),
    branchId: branchId(),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id),
    name: text('name').notNull(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    active: boolean('active').notNull().default(true),
    /** Bumped to invalidate all of a user's outstanding sessions (see revokeUserSessions). */
    sessionVersion: integer('session_version').notNull().default(0),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('users_email_uq').on(t.email), // global: login is by email alone
    index('users_company_idx').on(t.companyId),
    index('users_branch_idx').on(t.companyId, t.branchId),
    index('users_role_idx').on(t.roleId),
  ],
)

export const activityLog = pgTable(
  'activity_log',
  {
    id: id(),
    companyId: companyId(),
    userId: uuid('user_id').references(() => users.id),
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    entityId: text('entity_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    ip: text('ip'),
    createdAt: createdAt(),
  },
  (t) => [
    index('activity_log_company_created_idx').on(t.companyId, t.createdAt),
    index('activity_log_entity_idx').on(t.companyId, t.entity, t.entityId),
    index('activity_log_user_idx').on(t.userId),
  ],
)

export const recordHistory = pgTable(
  'record_history',
  {
    id: id(),
    companyId: companyId(),
    entity: text('entity').notNull(),
    entityId: text('entity_id').notNull(),
    changedBy: uuid('changed_by').references(() => users.id),
    diff: jsonb('diff').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('record_history_entity_idx').on(t.companyId, t.entity, t.entityId)],
)

/**
 * Failed-login counters shared by every server instance (company-independent: login happens before a company is known).
 * key_hash = HMAC(AUTH_SECRET, kind + key): emails and IPs are never stored in clear. One row per key, fixed window.
 */
export const loginAttempts = pgTable(
  'login_attempts',
  {
    keyHash: text('key_hash').primaryKey(),
    kind: text('kind').$type<'email' | 'email_ip'>().notNull(),
    count: integer('count').notNull().default(0),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull().defaultNow(),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
  },
  (t) => [index('login_attempts_window_idx').on(t.windowStart)],
)
