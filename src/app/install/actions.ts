'use server'

import { z } from 'zod'
import { safeLog } from '@/server/errors'
import {
  AlreadyInstalledError,
  checkEnv,
  installGate,
  installGuard,
  installErrorView,
  installInputSchema,
  isInstalled,
  isProdLike,
  runMigrations,
  seedBase,
  testConnection,
  type CheckResult,
} from '@/server/install'

export type MigrateState = { ok: true; total: number } | { ok: false; error: string }
export type CreateAdminState = { ok?: boolean; error?: string; fieldErrors?: Record<string, string> }
export type EnvView = { databaseUrl: CheckResult; authSecret: CheckResult; connection: CheckResult | null; vercel: boolean }
export type EnvCheckState = { ok: true; env: EnvView } | { ok: false; error: string }

const FORBIDDEN = 'Forbidden (403): ssERP is already installed. The installer cannot be run again.'
const TOKEN_DISABLED_MSG =
  'Web install is disabled: set INSTALL_TOKEN (16+ characters) in your environment variables and redeploy, or run `npm run setup` locally.'

/** Every installer action starts here: token gate first (leaks nothing), then install state, then env. */
async function precheck(token: string | null | undefined, opts: { needEnv: boolean } = { needEnv: true }): Promise<string | null> {
  const gate = installGate({ configured: process.env.INSTALL_TOKEN, prodLike: isProdLike(), presented: token })
  if (gate === 'disabled') return TOKEN_DISABLED_MSG
  if (gate === 'misconfigured') return 'INSTALL_TOKEN must be at least 16 characters. Fix it in your environment variables and redeploy.'
  if (gate === 'token-required') return 'Invalid or missing install token.'
  const decision = installGuard(await isInstalled(), 'install')
  if (decision === 'forbidden') return FORBIDDEN
  if (decision === 'unavailable') return 'The database is unavailable right now, so the install state cannot be verified. Try again shortly.'
  if (opts.needEnv && !checkEnv().ready) return 'DATABASE_URL and AUTH_SECRET must both be set before installing.'
  return null
}

const asToken = (v: unknown) => (typeof v === 'string' ? v : null)

/** Environment + live connection check; connection details are only returned after the gate passes. */
export async function checkEnvAction(token: string | null): Promise<EnvCheckState> {
  const blocked = await precheck(asToken(token), { needEnv: false })
  if (blocked) return { ok: false, error: blocked }
  const env = checkEnv()
  const connection = env.databaseUrl.ok ? await testConnection() : null
  return { ok: true, env: { databaseUrl: env.databaseUrl, authSecret: env.authSecret, connection, vercel: !!process.env.VERCEL } }
}

export async function runMigrationsAction(token: string | null): Promise<MigrateState> {
  const blocked = await precheck(asToken(token))
  if (blocked) return { ok: false, error: blocked }
  const conn = await testConnection()
  if (!conn.ok) return { ok: false, error: `Cannot connect to the database: ${conn.error}` }
  try {
    const { total } = await runMigrations()
    return { ok: true, total }
  } catch (e) {
    safeLog('[install] migrations failed:', e)
    return { ok: false, error: installErrorView(e, 'migrate').error ?? 'Migration failed. See server logs.' }
  }
}

const formSchema = installInputSchema
  .extend({ confirmPassword: z.string() })
  .refine((d) => d.adminPassword === d.confirmPassword, { path: ['confirmPassword'], message: 'Passwords do not match' })

export async function createAdminAction(_prev: CreateAdminState, formData: FormData): Promise<CreateAdminState> {
  const blocked = await precheck(asToken(formData.get('installToken')))
  if (blocked) return { error: blocked }

  const parsed = formSchema.safeParse({
    companyName: formData.get('companyName'),
    adminName: formData.get('adminName'),
    adminEmail: formData.get('adminEmail'),
    adminPassword: formData.get('adminPassword'),
    confirmPassword: formData.get('confirmPassword'),
    currency: String(formData.get('currency') ?? '') || undefined,
  })
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {}
    for (const issue of parsed.error.issues) {
      const k = String(issue.path[0] ?? 'form')
      fieldErrors[k] ??= issue.message
    }
    return { fieldErrors }
  }
  try {
    const { confirmPassword: _c, ...input } = parsed.data
    void _c
    await seedBase(input)
    return { ok: true }
  } catch (e) {
    if (e instanceof AlreadyInstalledError) return { error: FORBIDDEN }
    safeLog('[install] seed failed:', e)
    // Never echo the raw error to the browser: a DrizzleQueryError message contains the query params (the admin's password hash).
    return installErrorView(e, 'seed')
  }
}
