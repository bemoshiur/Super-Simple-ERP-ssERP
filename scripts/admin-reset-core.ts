/** Pure helpers for `npm run admin:reset` (no DB, no I/O) so they can be unit tested. */
import { MIN_ADMIN_PASSWORD_LENGTH } from '../src/server/install-env'

export type ResetArgs = { email: string | null; help: boolean; unknown: string[] }

/** Accepts `--email you@x.com` or `--email=you@x.com`; also `-h/--help`. Anything else is reported as unknown. */
export function parseArgs(argv: string[]): ResetArgs {
  const out: ResetArgs = { email: null, help: false, unknown: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') out.help = true
    else if (a === '--email') out.email = argv[++i] ?? ''
    else if (a.startsWith('--email=')) out.email = a.slice('--email='.length)
    else out.unknown.push(a)
  }
  return out
}

/** Login emails are stored trimmed and lower-cased (see the login action). */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

export function validateEmail(email: string): string | null {
  if (!email) return 'An email is required: npm run admin:reset -- --email you@example.com'
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'That does not look like a valid email address.'
  return null
}

export function validateNewPassword(pw: string): string | null {
  if (pw.length < MIN_ADMIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters.`
  if (pw.length > 200) return 'Password must be at most 200 characters.'
  return null
}
