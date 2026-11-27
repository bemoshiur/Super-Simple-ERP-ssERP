/**
 * Pure helpers for the serial lookup / unit history pages: search-term normalisation, warranty countdown and the
 * timeline view model. No DB or Node imports, so the client and the tests can use them.
 */
import { daysBetween } from '../dates'
import { SERIAL_MAX_LENGTH, normalizeSerial } from '../purchases/serialInput'
import type { UnitEventType } from '../serials'

// ------------------------------------------------------------------ search term

/** Scanner / paste clean-up: invisible characters out, whitespace trimmed and collapsed, capped to the serial length limit. */
export function normalizeSearchTerm(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return normalizeSerial(raw).replace(/\s+/g, ' ').slice(0, SERIAL_MAX_LENGTH)
}

// ------------------------------------------------------------------ warranty

export type WarrantyState = 'none' | 'active' | 'expires_today' | 'expired'
export type WarrantyInfo = { state: WarrantyState; days: number; label: string; tone: 'secondary' | 'success' | 'warning' | 'danger' }

/**
 * Warranty countdown by calendar date. `end` is the LAST covered day (inclusive), so on the end date itself the
 * unit is still covered ("Expires today"). `today` must be the shop-local date (localDate(appTimezone())).
 */
export function warrantyInfo(end: string | null | undefined, today: string): WarrantyInfo {
  if (!end) return { state: 'none', days: 0, label: 'No warranty', tone: 'secondary' }
  const d = daysBetween(today, end)
  if (d < 0) {
    const n = -d
    return { state: 'expired', days: n, label: `Expired ${n} day${n === 1 ? '' : 's'} ago`, tone: 'danger' }
  }
  if (d === 0) return { state: 'expires_today', days: 0, label: 'Expires today', tone: 'warning' }
  return { state: 'active', days: d, label: `${d} day${d === 1 ? '' : 's'} remaining`, tone: d <= 30 ? 'warning' : 'success' }
}

/** True when the warranty still covers `today` (inclusive of the end date). */
export const isUnderWarranty = (end: string | null | undefined, today: string): boolean => {
  const w = warrantyInfo(end, today)
  return w.state === 'active' || w.state === 'expires_today'
}

// ------------------------------------------------------------------ timeline

export const EVENT_LABEL: Readonly<Record<UnitEventType, string>> = {
  purchased: 'Purchased',
  sold: 'Sold',
  sale_returned: 'Returned by customer',
  returned_to_vendor: 'Returned to vendor',
  sent_to_service: 'Sent to service',
  returned_from_service: 'Back from service',
  marked_damaged: 'Marked damaged',
  status_changed: 'Status changed',
  note: 'Note',
  transferred: 'Moved to another branch',
}

export const EVENT_TONE: Readonly<Record<UnitEventType, string>> = {
  purchased: 'success',
  sold: 'primary',
  sale_returned: 'warning',
  returned_to_vendor: 'secondary',
  sent_to_service: 'info',
  returned_from_service: 'info',
  marked_damaged: 'danger',
  status_changed: 'secondary',
  note: 'secondary',
  transferred: 'secondary',
}

export type TimelineDoc = { kind: 'purchase' | 'sale' | 'sale_return' | 'purchase_return' | 'service_ticket'; id: string; label: string; href: string } | null

export type RawTimelineEvent = {
  id: string
  type: UnitEventType
  at: Date
  fromStatus: string | null
  toStatus: string | null
  price: string | null
  note: string | null
  actorName: string | null
  doc: TimelineDoc
}

export type TimelineEntry = RawTimelineEvent & { label: string; tone: string; statusChange: string | null; seq: number }

const statusWord = (s: string) => s.replace(/_/g, ' ')

/** Oldest first (or newest first). Stable: ties keep the order they were read in. */
export function buildTimeline(events: readonly RawTimelineEvent[], order: 'asc' | 'desc' = 'asc'): TimelineEntry[] {
  const out = events
    .map((e, seq) => ({
      ...e,
      seq,
      label: EVENT_LABEL[e.type] ?? e.type,
      tone: EVENT_TONE[e.type] ?? 'secondary',
      statusChange: e.fromStatus && e.toStatus && e.fromStatus !== e.toStatus ? `${statusWord(e.fromStatus)} → ${statusWord(e.toStatus)}` : e.toStatus && !e.fromStatus ? `→ ${statusWord(e.toStatus)}` : null,
    }))
    .sort((a, b) => a.at.getTime() - b.at.getTime() || a.seq - b.seq)
  return order === 'desc' ? out.reverse() : out
}
