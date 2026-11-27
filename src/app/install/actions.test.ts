import { DrizzleQueryError } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const HASH = '$2b$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234'
const DB_URL = 'postgresql://sserp:sup3r-s3cret-pw@db.example.internal:5432/sserp'

const seedBase = vi.fn()
const runMigrations = vi.fn()

vi.mock('@/server/install', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/server/install')>()
  return {
    ...orig,
    installGate: () => 'allow',
    isProdLike: () => false,
    isInstalled: async () => 'no',
    checkEnv: () => ({ ready: true }),
    testConnection: async () => ({ ok: true }),
    seedBase: (...a: unknown[]) => seedBase(...a),
    runMigrations: (...a: unknown[]) => runMigrations(...a),
  }
})

const { createAdminAction, runMigrationsAction } = await import('./actions')

function form() {
  const f = new FormData()
  for (const [k, v] of Object.entries({ companyName: 'Acme', adminName: 'Admin', adminEmail: 'admin@example.com', adminPassword: 'long-enough-password', confirmPassword: 'long-enough-password' })) f.set(k, v)
  return f
}

function queryError(code: string, constraint: string) {
  const pg = Object.assign(new Error(`violates "${constraint}" ${HASH}`), { code, constraint })
  return new DrizzleQueryError('insert into "users" values ($1, $2)', ['a@b.c', HASH, DB_URL], pg)
}

describe('install actions never echo raw database errors', () => {
  let logged: string
  beforeEach(() => {
    logged = ''
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void (logged += a.map(String).join(' ')))
  })
  afterEach(() => vi.restoreAllMocks())

  it('seed failure: generic message with the code, nothing secret in the response or the log', async () => {
    seedBase.mockRejectedValueOnce(queryError('23502', 'users_name_nn'))
    const res = await createAdminAction({}, form())
    const shown = JSON.stringify(res)
    expect(res.error).toBe('Installation failed (code 23502). See server logs.')
    for (const s of [shown, logged]) {
      expect(s).not.toContain(HASH)
      expect(s).not.toContain('$2b$')
      expect(s).not.toContain('sup3r-s3cret-pw')
      expect(s).not.toContain('Failed query')
    }
    expect(logged).toContain('code=23502')
  })

  it('duplicate email maps to the friendly field error', async () => {
    seedBase.mockRejectedValueOnce(queryError('23505', 'users_email_uq'))
    const res = await createAdminAction({}, form())
    expect(res).toEqual({ fieldErrors: { adminEmail: 'This email is already in use' } })
  })

  it('migration failure returns only the code', async () => {
    runMigrations.mockRejectedValueOnce(queryError('42501', 'x'))
    const res = await runMigrationsAction(null)
    expect(res).toEqual({ ok: false, error: 'Migration failed (code 42501). See server logs.' })
    expect(logged).not.toContain(HASH)
  })
})
