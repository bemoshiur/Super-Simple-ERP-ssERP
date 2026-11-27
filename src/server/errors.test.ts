import { DrizzleQueryError } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isDatabaseError, pgCodeOf, redactMessage, safeErrorInfo, safeLog } from './errors'
import { installErrorView, safeErrorMessage } from './install'

const HASH = '$2b$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234'
const DB_URL = 'postgresql://sserp:sup3r-s3cret-pw@db.example.internal:5432/sserp'

/** What drizzle-orm 0.45 throws: the message carries the SQL and its params; the pg error is the cause. */
function drizzleError(code = '23505', constraint = 'users_email_uq') {
  const pg = Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}" Key (email)=(a@b.c) ${HASH}`), {
    name: 'DatabaseError',
    code,
    constraint,
    table: 'users',
    routine: '_bt_check_unique',
    detail: `Key (password_hash)=(${HASH}) already exists.`,
  })
  return new DrizzleQueryError('insert into "users" ("email","password_hash") values ($1,$2)', ['a@b.c', HASH, DB_URL], pg)
}

describe('safeErrorInfo / safeLog', () => {
  afterEach(() => vi.restoreAllMocks())

  it('reports only class, code, constraint, table and routine for a DrizzleQueryError chain', () => {
    const out = safeErrorInfo(drizzleError())
    expect(out).toBe('DrizzleQueryError <- DatabaseError code=23505 constraint=users_email_uq table=users routine=_bt_check_unique')
    expect(out).not.toContain('$2b$')
    expect(out).not.toContain('sup3r-s3cret-pw')
    expect(out).not.toContain('a@b.c')
    expect(out).not.toContain('insert')
  })

  it('safeLog never writes the params, the hash or the connection string', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    safeLog('[test]', drizzleError())
    const written = spy.mock.calls.flat().map(String).join(' ')
    expect(written).toContain('[test]')
    expect(written).toContain('code=23505')
    expect(written).not.toContain(HASH)
    expect(written).not.toContain('$2b$12$')
    expect(written).not.toContain(DB_URL)
    expect(written).not.toContain('params')
  })

  it('a duck-typed query error (no class identity) is treated the same', () => {
    const fake = { message: `Failed query: select 1\nparams: ${HASH}`, cause: { code: '57P01' } }
    const out = safeErrorInfo(fake)
    expect(out).not.toContain(HASH)
    expect(out).toContain('code=57P01')
    expect(isDatabaseError(fake)).toBe(true)
  })

  it('keeps a truncated, redacted message for non-database errors', () => {
    const e = new TypeError(`cannot read x of ${DB_URL} with ${HASH} ${'z'.repeat(500)}`)
    const out = safeErrorInfo(e)
    expect(out.startsWith('TypeError message=')).toBe(true)
    expect(out).not.toContain('sup3r-s3cret-pw')
    expect(out).not.toContain(HASH)
    expect(out.length).toBeLessThan(260)
  })

  it('drops every message in a chain that contains a database error (outer errors may copy it)', () => {
    const outer = new Error(`wrapped: ${HASH}`, { cause: drizzleError() })
    expect(safeErrorInfo(outer)).not.toContain(HASH)
  })

  it('handles non-errors and cycles', () => {
    expect(safeErrorInfo('boom')).toContain('boom')
    const a: { cause?: unknown; message: string } = { message: 'loop' }
    a.cause = a
    expect(() => safeErrorInfo(a)).not.toThrow()
    expect(safeErrorInfo(undefined)).toBe('undefined')
  })

  it('redactMessage masks env secrets and URLs', () => {
    const env = { AUTH_SECRET: 'abcdefghijklmnopqrstuvwxyz0123456789', DATABASE_URL: DB_URL }
    const out = redactMessage(`x ${env.AUTH_SECRET} y sup3r-s3cret-pw z ${DB_URL}`, env)
    expect(out).not.toContain(env.AUTH_SECRET)
    expect(out).not.toContain('sup3r-s3cret-pw')
  })

  it('pgCodeOf walks the cause chain', () => {
    expect(pgCodeOf(drizzleError('42P01'))).toBe('42P01')
    expect(pgCodeOf(new Error('x'))).toBeUndefined()
  })
})

describe('installer error views', () => {
  it('safeErrorMessage reports only the code for database errors', () => {
    const msg = safeErrorMessage(drizzleError(), DB_URL)
    expect(msg).toBe('Database error (code 23505)')
  })

  it('maps a duplicate admin email to a field error and everything else to a code', () => {
    expect(installErrorView(drizzleError(), 'seed')).toEqual({ fieldErrors: { adminEmail: 'This email is already in use' } })
    expect(installErrorView(drizzleError('42P01', 'x'), 'seed').error).toMatch(/run the migrations first/)
    const other = installErrorView(drizzleError('23502', 'users_name_nn'), 'seed').error ?? ''
    expect(other).toBe('Installation failed (code 23502). See server logs.')
    expect(installErrorView(new Error(HASH), 'migrate').error).toBe('Migration failed. See server logs.')
  })
})
