/**
 * Pure installer helpers: env validation, secret generation, .env merging, install-guard decision.
 * No DB, no Next imports, no `server-only`: shared by the web wizard, scripts/setup.ts and unit tests.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const MIN_AUTH_SECRET_LENGTH = 32
export const MIN_ADMIN_PASSWORD_LENGTH = 10

export type CheckResult = { ok: true } | { ok: false; error: string }

export function validateDatabaseUrl(value: string | undefined | null): CheckResult {
  const v = (value ?? '').trim()
  if (!v) return { ok: false, error: 'DATABASE_URL is not set.' }
  let u: URL
  try {
    u = new URL(v)
  } catch {
    return { ok: false, error: 'DATABASE_URL is not a valid URL. Expected postgresql://user:password@host/dbname?sslmode=require' }
  }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
    return { ok: false, error: 'DATABASE_URL must start with postgres:// or postgresql://' }
  }
  if (!u.hostname) return { ok: false, error: 'DATABASE_URL has no host.' }
  if (u.pathname.replace(/^\//, '') === '') return { ok: false, error: 'DATABASE_URL has no database name.' }
  return { ok: true }
}

export function validateAuthSecret(value: string | undefined | null): CheckResult {
  const v = value ?? ''
  if (!v) return { ok: false, error: 'AUTH_SECRET is not set.' }
  if (v.length < MIN_AUTH_SECRET_LENGTH) return { ok: false, error: `AUTH_SECRET is too short: it must be at least ${MIN_AUTH_SECRET_LENGTH} characters.` }
  return { ok: true }
}

export type EnvStatus = {
  databaseUrl: CheckResult
  authSecret: CheckResult
  /** Both variables present and valid. */
  ready: boolean
}

export function checkEnv(env: Record<string, string | undefined> = process.env): EnvStatus {
  const databaseUrl = validateDatabaseUrl(env.DATABASE_URL)
  const authSecret = validateAuthSecret(env.AUTH_SECRET)
  return { databaseUrl, authSecret, ready: databaseUrl.ok && authSecret.ok }
}

/** 48 random bytes, base64url: 64 chars, well above the 32-char minimum. */
export function generateAuthSecret(): string {
  return randomBytes(48).toString('base64url')
}

/** Replace the password in a connection string so it can be shown or logged. */
export function redactDatabaseUrl(value: string): string {
  try {
    const u = new URL(value)
    if (u.password) u.password = '***'
    return u.toString()
  } catch {
    return '(invalid URL)'
  }
}

/** Parse KEY=value lines (supports `export`, quotes, comments). Later duplicates win. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw)
    if (!m) continue
    out[m[1]] = unquote(m[2].trim())
  }
  return out
}

function unquote(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).replace(/\\(["\\$])/g, '$1')
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/\\\$/g, '$')
  const hash = v.search(/\s#/)
  return hash >= 0 ? v.slice(0, hash).trim() : v
}

/**
 * Quote for Next.js's .env loader (dotenv + dotenv-expand): `$` would start a variable expansion, so it is written as `\$`
 * (dotenv-expand turns it back into `$`). Single quotes keep backslashes and `"` literal (dotenv does not unescape `\"`
 * inside double quotes, and expands `\n` there); a value containing `'` falls back to double quotes.
 */
function quoteIfNeeded(v: string): string {
  if (!/[\s#"'\\$`]/.test(v) && v !== '') return v
  const dollar = v.replace(/\$/g, '\\$')
  return v.includes("'") ? `"${dollar.replace(/"/g, '\\"')}"` : `'${dollar}'`
}

/**
 * Merge `updates` into existing .env text: matching keys are replaced in place, other lines
 * (comments, unrelated variables, blank lines) are preserved, new keys are appended.
 */
export function mergeEnv(existing: string, updates: Record<string, string>): string {
  const pending = new Map(Object.entries(updates))
  const lines = existing === '' ? [] : existing.replace(/\r\n/g, '\n').split('\n')
  const out = lines.map((line) => {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)
    if (m && pending.has(m[1])) {
      const v = pending.get(m[1])!
      pending.delete(m[1])
      return `${m[1]}=${quoteIfNeeded(v)}`
    }
    return line
  })
  // Drop trailing blank lines before appending, then ensure a single trailing newline.
  while (out.length && out[out.length - 1].trim() === '') out.pop()
  for (const [k, v] of pending) out.push(`${k}=${quoteIfNeeded(v)}`)
  return out.join('\n') + '\n'
}

export type InstallArea = 'app' | 'install'
export type InstalledState = 'yes' | 'no' | 'unknown'
export type GuardDecision = 'allow' | 'redirect-install' | 'forbidden' | 'unavailable'

/**
 * Where a request should go given the install state.
 * - app pages (admin shell, login): need an installed system, else send to the wizard.
 * - install pages and actions: only while NOT installed; once installed they are forbidden (403).
 * - 'unknown' (DB error that is not "tables missing"): never guess; show an unavailable state.
 */
export function installGuard(state: InstalledState, area: InstallArea): GuardDecision {
  if (state === 'unknown') return 'unavailable'
  if (area === 'app') return state === 'yes' ? 'allow' : 'redirect-install'
  return state === 'yes' ? 'forbidden' : 'allow'
}

/** True for Postgres 42P01 (undefined_table), looking through wrapped errors (`cause`). */
export function isUndefinedTableError(e: unknown): boolean {
  let cur: unknown = e
  for (let i = 0; i < 5 && cur && typeof cur === 'object'; i++) {
    const o = cur as { code?: unknown; message?: unknown; cause?: unknown }
    if (o.code === '42P01') return true
    if (typeof o.message === 'string' && /relation ".*" does not exist/i.test(o.message)) return true
    cur = o.cause
  }
  return false
}

/** Install state from a settings lookup outcome. Only a clean "no row" or a missing table is 'no'. */
export function classifyInstalled(outcome: { rows: number } | { error: unknown }): InstalledState {
  if ('error' in outcome) return isUndefinedTableError(outcome.error) ? 'no' : 'unknown'
  return outcome.rows > 0 ? 'yes' : 'no'
}

// ---- web installer token gate ----

export const MIN_INSTALL_TOKEN_LENGTH = 16
export type GateDecision2 = 'allow' | 'token-required' | 'disabled' | 'misconfigured'

/** Length-safe constant-time string comparison. */
export function tokensMatch(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}

/**
 * Who may use the web installer.
 * - token configured (>= 16 chars): allow only when the presented token matches, else 'token-required'.
 * - token configured but too short: 'misconfigured' (refused).
 * - no token: allowed in local dev, 'disabled' on Vercel / production builds.
 */
export function installGate(i: { configured: string | undefined; prodLike: boolean; presented?: string | null }): GateDecision2 {
  const configured = i.configured ?? ''
  if (configured !== '') {
    if (configured.length < MIN_INSTALL_TOKEN_LENGTH) return 'misconfigured'
    return i.presented && tokensMatch(configured, i.presented) ? 'allow' : 'token-required'
  }
  return i.prodLike ? 'disabled' : 'allow'
}

export const isProdLike = (env: Record<string, string | undefined> = process.env) => !!env.VERCEL || env.NODE_ENV === 'production'

/** Decision made inside the seed transaction: installed flag OR any existing user blocks installing. */
export function seedPreflight(i: { installedFlag: boolean; userCount: number }): 'ok' | 'installed' | 'not-empty' {
  if (i.installedFlag) return 'installed'
  return i.userCount > 0 ? 'not-empty' : 'ok'
}

export type AdminInput = { companyName: string; adminName: string; adminEmail: string; adminPassword: string; currency?: string }
