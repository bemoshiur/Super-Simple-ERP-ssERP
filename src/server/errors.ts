import { ZodError } from 'zod'

/** The id does not exist in the caller's company (an id from another company looks exactly like this). */
export class NotFoundError extends Error {
  constructor(what = 'Record') {
    super(`${what} not found`)
    this.name = 'NotFoundError'
  }
}

/** A user-correctable problem tied to form fields, e.g. { sku: 'This SKU is already in use' }. */
export class FieldErrors extends Error {
  constructor(
    public fields: Record<string, string>,
    message = 'Please fix the highlighted fields.',
  ) {
    super(message)
    this.name = 'FieldErrors'
  }
}

/** A business rule refused the operation (e.g. last administrator, privilege escalation). The message is safe to show. */
export class PolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PolicyError'
  }
}

type PgLike = { code?: string; constraint?: string; cause?: unknown }

/** Find the underlying Postgres error (drizzle wraps driver errors in `cause`). */
export function pgErrorOf(e: unknown): { code?: string; constraint?: string } | null {
  let cur: unknown = e
  for (let i = 0; i < 5 && cur && typeof cur === 'object'; i++) {
    const c = cur as PgLike
    if (typeof c.code === 'string' && /^[0-9A-Z]{5}$/.test(c.code)) return { code: c.code, constraint: c.constraint }
    cur = c.cause
  }
  return null
}

/** True for a Postgres unique violation (23505), optionally for one named constraint/index. */
export function isUniqueViolation(e: unknown, constraint?: string): boolean {
  const pg = pgErrorOf(e)
  return !!pg && pg.code === '23505' && (constraint === undefined || pg.constraint === constraint)
}

/** First message per top-level field of a zod error. */
export function zodFieldErrors(err: ZodError): Record<string, string> {
  const out: Record<string, string> = {}
  for (const issue of err.issues) {
    const key = issue.path.length ? String(issue.path[0]) : '_'
    if (!(key in out)) out[key] = issue.message
  }
  return out
}

/** Every zod issue keyed by its full dotted path (e.g. "items.2.qty"), first message wins. Good for line-item forms. */
export function zodPathErrors(err: ZodError): Record<string, string> {
  const out: Record<string, string> = {}
  for (const issue of err.issues) {
    const key = issue.path.length ? issue.path.map(String).join('.') : '_'
    if (!(key in out)) out[key] = issue.message
  }
  return out
}

// ---------- safe error logging ----------

type ErrLink = { name?: unknown; message?: unknown; code?: unknown; constraint?: unknown; table?: unknown; routine?: unknown; cause?: unknown; query?: unknown; params?: unknown }

/**
 * drizzle-orm's DrizzleQueryError puts the full SQL **and its bound parameters** in `message`
 * ("Failed query: ... params: ..."), which can include password hashes and other secrets.
 * Detected by duck typing so it also works across module copies.
 */
function isDrizzleQueryError(e: ErrLink): boolean {
  return ('query' in e && 'params' in e) || (typeof e.message === 'string' && e.message.startsWith('Failed query:'))
}

const isPgCode = (c: unknown): c is string => typeof c === 'string' && /^[0-9A-Z]{5}$/.test(c)

const MAX_MESSAGE = 200

/** Mask what could be a secret in a free-text (non-database) error message. */
export function redactMessage(msg: string, env: Record<string, string | undefined> = process.env): string {
  let out = msg
    .replace(/postgres(ql)?:\/\/[^\s'"]*/gi, 'postgresql://***')
    .replace(/\$2[abxy]?\$\d{2}\$[./A-Za-z0-9]{20,}/g, '[bcrypt-hash]')
  for (const key of ['AUTH_SECRET', 'INSTALL_TOKEN', 'ADMIN_RESET_PASSWORD']) {
    const v = env[key]
    if (v && v.length >= 8) out = out.split(v).join('***')
  }
  const url = env.DATABASE_URL
  if (url) {
    try {
      const pw = new URL(url).password
      if (pw) out = out.split(pw).join('***').split(decodeURIComponent(pw)).join('***')
    } catch {
      /* not a URL */
    }
  }
  return out.length > MAX_MESSAGE ? `${out.slice(0, MAX_MESSAGE)}…` : out
}

/**
 * A log-safe one-line description of an error and its `cause` chain: class name, Postgres `code`, `constraint`, `table`
 * and `routine` only. Never the message, query or params of a database error. A plain (non-database) error keeps a
 * truncated, redacted message, but only when nothing in the chain is a database error (an outer error may copy the
 * inner message).
 */
export function safeErrorInfo(e: unknown): string {
  const links: ErrLink[] = []
  let cur: unknown = e
  for (let i = 0; i < 6 && cur !== undefined && cur !== null; i++) {
    if (typeof cur !== 'object') {
      links.push({ name: typeof cur, message: String(cur) })
      break
    }
    links.push(cur as ErrLink)
    cur = (cur as ErrLink).cause
  }
  if (links.length === 0) return String(e)
  const dbChain = links.some((l) => isDrizzleQueryError(l) || isPgCode(l.code))
  return links
    .map((l) => {
      const ctor = (l as { constructor?: { name?: unknown } }).constructor?.name
      const rawName = isDrizzleQueryError(l) ? 'DrizzleQueryError' : typeof l.name === 'string' && l.name !== 'Error' ? l.name : typeof ctor === 'string' && ctor !== 'Object' ? ctor : String(l.name ?? 'Error')
      const name = String(rawName).replace(/[^\w.-]/g, '').slice(0, 60) || 'Error'
      const parts = [name]
      if (isPgCode(l.code)) parts.push(`code=${l.code}`)
      for (const k of ['constraint', 'table', 'routine'] as const) {
        const v = l[k]
        if (typeof v === 'string' && /^[\w.-]{1,80}$/.test(v)) parts.push(`${k}=${v}`)
      }
      if (!dbChain && typeof l.message === 'string' && l.message) parts.push(`message=${JSON.stringify(redactMessage(l.message))}`)
      return parts.join(' ')
    })
    .join(' <- ')
}

/** True when `e` or anything in its cause chain is a database error (DrizzleQueryError or a Postgres-coded error). */
export function isDatabaseError(e: unknown): boolean {
  let cur: unknown = e
  for (let i = 0; i < 6 && cur && typeof cur === 'object'; i++) {
    const l = cur as ErrLink
    if (isDrizzleQueryError(l) || isPgCode(l.code)) return true
    cur = l.cause
  }
  return false
}

/** The Postgres error code anywhere in the cause chain, if any (for user-facing "code X" messages). */
export function pgCodeOf(e: unknown): string | undefined {
  return pgErrorOf(e)?.code
}

/** Log a caught error without leaking secrets (see safeErrorInfo). Use this instead of passing the raw error to console.error. */
export function safeLog(tag: string, e: unknown, level: 'error' | 'warn' = 'error'): void {
  const line = `${tag} ${safeErrorInfo(e)}`
  if (level === 'warn') console.warn(line)
  else console.error(line)
}
