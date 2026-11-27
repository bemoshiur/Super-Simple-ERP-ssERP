export const DEFAULT_TIMEZONE = 'Asia/Dhaka'
const TZ_RE = /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/

/** The shop's IANA time zone (APP_TIMEZONE, default Asia/Dhaka). Invalid values fall back to the default. */
export function appTimezone(env: Record<string, string | undefined> = process.env): string {
  const tz = env.APP_TIMEZONE?.trim()
  return tz && TZ_RE.test(tz) && isKnownZone(tz) ? tz : DEFAULT_TIMEZONE
}

/** The runtime's ICU knows this zone (an unknown one would make every Intl date format throw). */
function isKnownZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** The calendar date (YYYY-MM-DD) "now" in an IANA time zone, e.g. the shop's Asia/Dhaka day. Pure apart from the clock. */
export function localDate(tz: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  } catch {
    return now.toISOString().slice(0, 10)
  }
}

/** "2026-11-30" + 1 -> "2026-12-01" (pure calendar arithmetic on YYYY-MM-DD, no time zone involved). */
export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** "2026-11-26 14:05" for an instant, shown in an IANA time zone (the shop's, not the server's). Pure apart from Intl. */
export function formatLocalDateTime(d: Date | string, tz: string): string {
  const date = typeof d === 'string' ? new Date(d) : d
  if (Number.isNaN(date.getTime())) return ''
  const fmt = (zone: string) => {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date)
    const g = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
    return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`
  }
  try {
    return fmt(tz)
  } catch {
    return fmt('UTC')
  }
}

/** Whole calendar days from `from` to `to` (both YYYY-MM-DD); negative when `to` is earlier. Date-only math: no time zone, no DST. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}
