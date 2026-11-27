import { describe, expect, it } from 'vitest'
import { addDays, daysBetween, formatLocalDateTime, localDate } from '../dates'
import { OUTCOME_EFFECT, closeTicketSchema, openTicketSchema, updateTicketSchema } from '../service/schemas'
import { decodeIfEncoded, docHref, linkAccess } from './links'
import { buildTimeline, isUnderWarranty, normalizeSearchTerm, warrantyInfo, type RawTimelineEvent } from './pure'

describe('normalizeSearchTerm', () => {
  it('trims, strips BOM / zero-width characters, collapses inner whitespace', () => {
    expect(normalizeSearchTerm('  HIK123456789\n')).toBe('HIK123456789')
    expect(normalizeSearchTerm('﻿HIK1​2‍3­')).toBe('HIK123')
    expect(normalizeSearchTerm('a \t\n  b')).toBe('a b')
    expect(normalizeSearchTerm('⁠ ​ ')).toBe('')
  })
  it('keeps letter case (serials are case-sensitive) and caps the length', () => {
    expect(normalizeSearchTerm('AbC-1')).toBe('AbC-1')
    expect(normalizeSearchTerm('x'.repeat(200))).toHaveLength(64)
  })
  it('treats non-strings as empty', () => {
    expect(normalizeSearchTerm(undefined)).toBe('')
    expect(normalizeSearchTerm(null)).toBe('')
    expect(normalizeSearchTerm(123)).toBe('')
    expect(normalizeSearchTerm(['a'])).toBe('')
  })
})

describe('warranty days (date-only math)', () => {
  it('counts remaining days; the end date itself is still covered', () => {
    expect(warrantyInfo('2027-11-26', '2026-11-26')).toMatchObject({ state: 'active', days: 365, label: '365 days remaining', tone: 'success' })
    expect(warrantyInfo('2026-11-27', '2026-11-26')).toMatchObject({ state: 'active', days: 1, label: '1 day remaining', tone: 'warning' })
    expect(warrantyInfo('2026-11-26', '2026-11-26')).toMatchObject({ state: 'expires_today', days: 0, label: 'Expires today' })
    expect(warrantyInfo('2026-11-25', '2026-11-26')).toMatchObject({ state: 'expired', days: 1, label: 'Expired 1 day ago', tone: 'danger' })
    expect(warrantyInfo('2026-10-01', '2026-11-26')).toMatchObject({ state: 'expired', days: 56, label: 'Expired 56 days ago' })
  })
  it('no end date = no warranty', () => {
    expect(warrantyInfo(null, '2026-11-26')).toMatchObject({ state: 'none', label: 'No warranty' })
    expect(isUnderWarranty(null, '2026-11-26')).toBe(false)
    expect(isUnderWarranty('2026-11-26', '2026-11-26')).toBe(true)
    expect(isUnderWarranty('2026-11-25', '2026-11-26')).toBe(false)
  })
  it('is exact across month, year and leap-day boundaries', () => {
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1)
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2) // leap year
    expect(daysBetween('2027-02-28', '2027-03-01')).toBe(1)
    expect(daysBetween('2026-01-01', '2027-01-01')).toBe(365)
    expect(daysBetween('2026-11-26', '2026-11-20')).toBe(-6)
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2) // DST changeover months are irrelevant to date-only math
    expect(daysBetween('2026-10-24', '2026-10-26')).toBe(2)
  })
  it('"today" is the shop-local date: the same instant is a different day in Dhaka and in Los Angeles', () => {
    const now = new Date('2026-11-26T20:30:00Z') // 02:30 on the 27th in Dhaka (UTC+6), 12:30 on the 26th in LA
    expect(localDate('Asia/Dhaka', now)).toBe('2026-11-27')
    expect(localDate('America/Los_Angeles', now)).toBe('2026-11-26')
    expect(warrantyInfo('2026-11-27', localDate('Asia/Dhaka', now)).state).toBe('expires_today')
    expect(warrantyInfo('2026-11-27', localDate('America/Los_Angeles', now))).toMatchObject({ state: 'active', days: 1 })
    // the instant just before / after midnight Dhaka
    expect(localDate('Asia/Dhaka', new Date('2026-11-26T17:59:59Z'))).toBe('2026-11-26')
    expect(localDate('Asia/Dhaka', new Date('2026-11-26T18:00:00Z'))).toBe('2026-11-27')
    expect(addDays('2026-11-27', 30)).toBe('2026-12-27')
  })
})

describe('formatLocalDateTime', () => {
  it('renders in the shop time zone, 24h, zero padded', () => {
    expect(formatLocalDateTime(new Date('2026-11-26T20:30:00Z'), 'Asia/Dhaka')).toBe('2026-11-27 02:30')
    expect(formatLocalDateTime(new Date('2026-11-26T20:30:00Z'), 'America/Los_Angeles')).toBe('2026-11-26 12:30')
    expect(formatLocalDateTime(new Date('2026-11-26T00:05:00Z'), 'UTC')).toBe('2026-11-26 00:05')
  })
  it('falls back to UTC for a bad zone and returns empty for an invalid date', () => {
    expect(formatLocalDateTime(new Date('2026-11-26T00:05:00Z'), 'Not/AZone')).toBe('2026-11-26 00:05')
    expect(formatLocalDateTime('garbage', 'UTC')).toBe('')
  })
})

describe('buildTimeline', () => {
  const ev = (id: string, type: RawTimelineEvent['type'], at: string, extra: Partial<RawTimelineEvent> = {}): RawTimelineEvent => ({ id, type, at: new Date(at), fromStatus: null, toStatus: null, price: null, note: null, actorName: null, doc: null, ...extra })
  const events = [
    ev('c', 'sale_returned', '2026-11-28T10:00:00Z', { fromStatus: 'sold', toStatus: 'in_stock' }),
    ev('a', 'purchased', '2026-11-20T10:00:00Z', { toStatus: 'in_stock', price: '2000.00' }),
    ev('b', 'sold', '2026-11-26T10:00:00Z', { fromStatus: 'in_stock', toStatus: 'sold', price: '2800.00' }),
    ev('d', 'sent_to_service', '2026-11-28T10:00:00Z', { fromStatus: 'in_stock', toStatus: 'in_service' }),
  ]
  it('orders oldest first by default, newest first on request, stable on ties', () => {
    expect(buildTimeline(events).map((e) => e.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(buildTimeline(events, 'desc').map((e) => e.id)).toEqual(['d', 'c', 'b', 'a'])
  })
  it('adds labels, tones and a readable status change', () => {
    const t = buildTimeline(events)
    expect(t[0]).toMatchObject({ label: 'Purchased', tone: 'success', statusChange: '→ in stock' })
    expect(t[1]).toMatchObject({ label: 'Sold', statusChange: 'in stock → sold' })
    expect(t[2]).toMatchObject({ label: 'Returned by customer', statusChange: 'sold → in stock' })
    expect(t[3]).toMatchObject({ label: 'Sent to service', statusChange: 'in stock → in service' })
  })
  it('does not mutate its input', () => {
    const copy = [...events]
    buildTimeline(events, 'desc')
    expect(events).toEqual(copy)
  })
})

describe('service ticket schemas', () => {
  it('open needs an issue; notes are optional', () => {
    expect(openTicketSchema.safeParse({ issue: 'no' }).success).toBe(false)
    expect(openTicketSchema.safeParse({ issue: '  Screen flickers  ', notes: '' }).data).toEqual({ issue: 'Screen flickers', notes: null })
    expect(openTicketSchema.safeParse({ issue: 'x'.repeat(1001) }).success).toBe(false)
  })
  it('update needs something to change; only in_progress is a valid status change', () => {
    expect(updateTicketSchema.safeParse({}).success).toBe(false)
    expect(updateTicketSchema.safeParse({ status: 'in_progress' }).success).toBe(true)
    expect(updateTicketSchema.safeParse({ status: 'closed' }).success).toBe(false)
    expect(updateTicketSchema.safeParse({ notes: 'called customer' }).success).toBe(true)
  })
  it('close needs an outcome and a resolution; each outcome maps to a unit status', () => {
    expect(closeTicketSchema.safeParse({ outcome: 'repaired' }).success).toBe(false)
    expect(closeTicketSchema.safeParse({ outcome: 'lost', resolution: 'x' }).success).toBe(false)
    expect(closeTicketSchema.safeParse({ outcome: 'repaired', resolution: 'Replaced board' }).success).toBe(true)
    expect(Object.fromEntries(Object.entries(OUTCOME_EFFECT).map(([k, v]) => [k, [v.ticket, v.unit]]))).toEqual({
      repaired: ['resolved', 'sold'],
      rejected: ['rejected', 'sold'],
      replaced: ['closed', 'in_stock'],
      unrepairable: ['closed', 'damaged'],
    })
  })
})

describe('link access (permission-aware links)', () => {
  const doc = (kind: 'purchase' | 'sale' | 'sale_return' | 'purchase_return' | 'service_ticket') => ({ kind, id: 'x', label: 'L', href: '/h' })
  it('maps session permissions to booleans', () => {
    expect(linkAccess({ adm: false, perms: ['serials.view'] })).toEqual({ sales: false, purchases: false, vendors: false, customers: false, products: false, serials: true })
    expect(linkAccess({ adm: true, perms: [] })).toEqual({ sales: true, purchases: true, vendors: true, customers: true, products: true, serials: true })
    expect(linkAccess(null).serials).toBe(false)
  })
  it('timeline documents link only with the target permission', () => {
    const none = linkAccess({ adm: false, perms: ['serials.view'] })
    const all = linkAccess({ adm: true, perms: [] })
    for (const k of ['purchase', 'sale', 'sale_return', 'purchase_return'] as const) {
      expect(docHref(doc(k), none)).toBeNull()
      expect(docHref(doc(k), all)).toBe('/h')
    }
    expect(docHref(doc('service_ticket'), none)).toBe('/h')
    expect(docHref(doc('sale'), linkAccess({ adm: false, perms: ['sales.view'] }))).toBe('/h')
    expect(docHref(doc('purchase'), linkAccess({ adm: false, perms: ['sales.view'] }))).toBeNull()
    expect(docHref(null, all)).toBeNull()
  })
  it('route segments: a literal % in a serial is left alone; real escapes decode', () => {
    expect(decodeIfEncoded('PCT%1')).toBe('PCT%1')
    expect(decodeIfEncoded('100%')).toBe('100%')
    expect(decodeIfEncoded('AB%2')).toBe('AB%2')
    expect(decodeIfEncoded('A%20B')).toBe('A B')
    expect(decodeIfEncoded('%E0%A4%A')).toBe('%E0%A4%A')
  })
})
