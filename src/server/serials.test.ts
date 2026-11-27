import { describe, expect, it } from 'vitest'
import { TRANSITIONS, UNIT_STATUSES, canTransition, eventTypeFor, type UnitStatus } from './serials'

describe('unit state machine', () => {
  it('has an entry for every status and only targets known statuses', () => {
    for (const s of UNIT_STATUSES) {
      expect(TRANSITIONS[s]).toBeDefined()
      for (const t of TRANSITIONS[s]) expect(UNIT_STATUSES).toContain(t)
      expect(TRANSITIONS[s]).not.toContain(s) // no self-loops
    }
  })

  it.each<[UnitStatus, UnitStatus]>([
    ['in_stock', 'sold'],
    ['in_stock', 'returned_to_vendor'],
    ['in_stock', 'damaged'],
    ['in_stock', 'in_service'],
    ['sold', 'in_stock'],
    ['sold', 'in_service'],
    ['sold', 'damaged'],
    ['in_service', 'in_stock'],
    ['in_service', 'sold'],
    ['in_service', 'damaged'],
    ['damaged', 'returned_to_vendor'],
    ['damaged', 'in_stock'],
  ])('allows %s -> %s', (from, to) => expect(canTransition(from, to)).toBe(true))

  it.each<[UnitStatus, UnitStatus]>([
    ['sold', 'sold'],
    ['sold', 'returned_to_vendor'], // must come back into stock first
    ['in_service', 'returned_to_vendor'],
    ['damaged', 'sold'],
    ['in_stock', 'in_stock'],
  ])('rejects %s -> %s', (from, to) => expect(canTransition(from, to)).toBe(false))

  it('returned_to_vendor is terminal', () => {
    for (const t of UNIT_STATUSES) expect(canTransition('returned_to_vendor', t)).toBe(false)
  })

  it('unknown statuses are rejected, not crashing', () => {
    expect(canTransition('lost' as UnitStatus, 'in_stock')).toBe(false)
  })

  it('maps transitions to event types', () => {
    expect(eventTypeFor('in_stock', 'sold')).toBe('sold')
    expect(eventTypeFor('in_stock', 'returned_to_vendor')).toBe('returned_to_vendor')
    expect(eventTypeFor('damaged', 'returned_to_vendor')).toBe('returned_to_vendor')
    expect(eventTypeFor('in_stock', 'in_service')).toBe('sent_to_service')
    expect(eventTypeFor('sold', 'in_service')).toBe('sent_to_service')
    expect(eventTypeFor('sold', 'in_stock')).toBe('sale_returned')
    expect(eventTypeFor('sold', 'damaged')).toBe('sale_returned')
    expect(eventTypeFor('in_service', 'in_stock')).toBe('returned_from_service')
    expect(eventTypeFor('in_service', 'sold')).toBe('returned_from_service')
    expect(eventTypeFor('in_stock', 'damaged')).toBe('marked_damaged')
    expect(eventTypeFor('in_service', 'damaged')).toBe('marked_damaged')
    expect(eventTypeFor('damaged', 'in_stock')).toBe('status_changed')
  })
})
