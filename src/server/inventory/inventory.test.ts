import { describe, expect, it } from 'vitest'
import { adjustmentProblem, mergeReloadedCounts, parseScannedSerials, parseSignedQty, quantityDiff, runningBalance, serialDiff } from './pure'
import { adjustmentSchema, applyCountSchema, countSchema } from './schemas'

const P1 = '11111111-1111-4111-8111-111111111111'
const P2 = '22222222-2222-4222-8222-222222222222'

describe('adjustment validation', () => {
  it('rejects zero, non-integers and oversized quantities', () => {
    expect(adjustmentProblem({ reason: 'other', qtyChange: 0 })).toMatch(/other than zero/)
    expect(adjustmentProblem({ reason: 'other', qtyChange: 1.5 })).toMatch(/whole number/)
    expect(adjustmentProblem({ reason: 'other', qtyChange: 1_000_001 })).toMatch(/At most/)
  })
  it('damage / loss only reduce, found only adds, count correction / other either way', () => {
    expect(adjustmentProblem({ reason: 'damage', qtyChange: 1 })).toMatch(/only reduce/)
    expect(adjustmentProblem({ reason: 'loss', qtyChange: 2 })).toMatch(/only reduce/)
    expect(adjustmentProblem({ reason: 'found', qtyChange: -1 })).toMatch(/only be added/)
    for (const reason of ['count_correction', 'other'] as const) {
      expect(adjustmentProblem({ reason, qtyChange: -1 })).toBeNull()
      expect(adjustmentProblem({ reason, qtyChange: 1 })).toBeNull()
    }
  })
  it('a reduction may not take on-hand below zero', () => {
    expect(adjustmentProblem({ reason: 'damage', qtyChange: -3, onHand: 3 })).toBeNull()
    expect(adjustmentProblem({ reason: 'damage', qtyChange: -4, onHand: 3, productName: 'Cable' })).toBe('Only 3 of Cable in stock: you can reduce by at most 3.')
    expect(adjustmentProblem({ reason: 'loss', qtyChange: -1, onHand: 0, productName: 'Cable' })).toBe('Cable has no stock to reduce.')
    expect(adjustmentProblem({ reason: 'found', qtyChange: 5, onHand: 0 })).toBeNull()
  })
  it('parses signed quantities strictly', () => {
    expect(parseSignedQty('-3')).toBe(-3)
    expect(parseSignedQty(' +2 ')).toBe(2)
    expect(parseSignedQty('-0')).toBe(0)
    for (const bad of ['', '1.5', '2e3', '--1', 'abc', '1 2', null, undefined]) expect(parseSignedQty(bad)).toBeNull()
  })
  it('schema: qty and unit adjustments', () => {
    expect(adjustmentSchema.parse({ kind: 'qty', productId: P1, qtyChange: '-2', reason: 'damage' })).toMatchObject({ qtyChange: -2, note: null, idempotencyKey: null })
    expect(adjustmentSchema.safeParse({ kind: 'qty', productId: P1, qtyChange: '0', reason: 'damage' }).success).toBe(false)
    expect(adjustmentSchema.safeParse({ kind: 'qty', productId: P1, qtyChange: '1', reason: 'stolen' }).success).toBe(false)
    expect(adjustmentSchema.safeParse({ kind: 'unit', productId: P1, reason: 'found', serial: 'X' }).success).toBe(false) // units: damage/loss only
    expect(adjustmentSchema.safeParse({ kind: 'unit', productId: P1, reason: 'loss' }).success).toBe(false) // needs a unit
    expect(adjustmentSchema.parse({ kind: 'unit', productId: P1, reason: 'loss', serial: ' S-1 ' })).toMatchObject({ serial: 'S-1', unitId: null })
    expect(adjustmentSchema.safeParse({ kind: 'qty', productId: P1, qtyChange: '1', reason: 'found', idempotencyKey: 'bad key!' }).success).toBe(false)
  })
})

describe('running balance (stock card twin)', () => {
  it('accumulates in ledger order from an opening balance', () => {
    expect(runningBalance([{ qtyChange: 10 }, { qtyChange: -3 }, { qtyChange: -7 }, { qtyChange: 2 }]).map((r) => r.balance)).toEqual([10, 7, 0, 2])
    expect(runningBalance([{ qtyChange: 1 }], 5)[0].balance).toBe(6)
    expect(runningBalance([])).toEqual([])
  })
})

describe('count diff', () => {
  const system = [
    { productId: P1, name: 'Cable', sku: 'CB-1', system: 10 },
    { productId: P2, name: 'Mouse', sku: 'MS-1', system: 3 },
  ]
  it('only counted products appear; diff = counted - system', () => {
    expect(quantityDiff(system, [{ productId: P1, counted: 8 }, { productId: P2, counted: null }])).toEqual([{ ...system[0], counted: 8, diff: -2 }])
    expect(quantityDiff(system, [{ productId: P2, counted: 3 }, { productId: P1, counted: 12 }]).map((r) => r.diff)).toEqual([2, 0])
    expect(quantityDiff(system, [{ productId: 'unknown', counted: 1 }])).toEqual([])
  })
  it('parses scanned serials: separators, invisible characters, duplicates', () => {
    expect(parseScannedSerials('A-1\r\nA-2, A-3;A-1\t​A-4﻿\n\n')).toEqual({ serials: ['A-1', 'A-2', 'A-3', 'A-4'], duplicates: ['A-1'] })
    expect(parseScannedSerials('')).toEqual({ serials: [], duplicates: [] })
  })
  it('serial diff: missing, unexpected (unknown / not in stock / other product), matched; case-sensitive', () => {
    const expected = [
      { unitId: 'u1', serialNo: 'S-1', productId: P1 },
      { unitId: 'u2', serialNo: 'S-2', productId: P1 },
    ]
    const known = [
      { unitId: 'u1', serialNo: 'S-1', productId: P1, productName: 'Phone', status: 'in_stock' },
      { unitId: 'u3', serialNo: 'S-3', productId: P1, productName: 'Phone', status: 'sold' },
      { unitId: 'u4', serialNo: 'Z-1', productId: P2, productName: 'Tab', status: 'in_stock' },
    ]
    const r = serialDiff(expected, ['S-1', 'S-3', 'Z-1', 's-2', 'NEW'], known, [P1])
    expect(r.matched).toBe(1)
    expect(r.missing.map((m) => m.serialNo)).toEqual(['S-2'])
    expect(r.unexpected.map((u) => [u.serialNo, u.reason])).toEqual([
      ['S-3', 'not_in_stock'],
      ['Z-1', 'other_product'],
      ['s-2', 'unknown'],
      ['NEW', 'unknown'],
    ])
  })
  it('count schemas: blank counted = not counted; negative / fractional refused', () => {
    expect(countSchema.parse({ lines: [{ productId: P1, counted: '' }, { productId: P2, counted: '4' }] }).lines.map((l) => l.counted)).toEqual([null, 4])
    expect(countSchema.safeParse({ lines: [{ productId: P1, counted: '-1' }] }).success).toBe(false)
    expect(countSchema.safeParse({ lines: [{ productId: P1, counted: '1.5' }] }).success).toBe(false)
    expect(applyCountSchema.safeParse({ lines: [] }).success).toBe(false)
    expect(applyCountSchema.safeParse({ lines: [{ productId: P1, counted: '2' }] }).success).toBe(false) // system qty required
  })
})

describe('fix round 1: reloaded count sheet keeps unchanged counts', () => {
  it('keeps counts of unchanged products, clears and reports moved ones, reports moved serial products', () => {
    const prev = [
      { productId: 'a', name: 'Cable', trackSerial: false, system: 10 },
      { productId: 'b', name: 'Mouse', trackSerial: false, system: 5 },
      { productId: 'c', name: 'Phone', trackSerial: true, system: 3 },
      { productId: 'd', name: 'Pen', trackSerial: false, system: 7 },
    ]
    const next = [
      { productId: 'a', name: 'Cable', trackSerial: false, system: 9 },
      { productId: 'b', name: 'Mouse', trackSerial: false, system: 5 },
      { productId: 'c', name: 'Phone', trackSerial: true, system: 2 },
      { productId: 'd', name: 'Pen', trackSerial: false, system: 8 },
      { productId: 'e', name: 'New', trackSerial: false, system: 1 },
    ]
    const r = mergeReloadedCounts(prev, next, { a: '8', b: '4', d: '' })
    expect(r.counted).toEqual({ b: '4' })
    expect(r.moved).toEqual([
      { productId: 'a', name: 'Cable', trackSerial: false, was: 10, now: 9 },
      { productId: 'c', name: 'Phone', trackSerial: true, was: 3, now: 2 },
    ])
    expect(mergeReloadedCounts(prev, prev, { a: '1', b: '2' })).toEqual({ counted: { a: '1', b: '2' }, moved: [] })
  })
})

describe('fix round 1: capped body reader for the count CSV route', () => {
  it('returns the text under the cap and null over it, without trusting content-length', async () => {
    const { readCapped } = await import('../reports/csvResponse')
    expect(await readCapped(new Request('http://x/', { method: 'POST', body: 'payload=abc' }), 100)).toBe('payload=abc')
    const big = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 10; i++) c.enqueue(new Uint8Array(50))
        c.close()
      },
    })
    expect(await readCapped(new Request('http://x/', { method: 'POST', body: big, headers: { 'content-length': '10' }, duplex: 'half' } as RequestInit), 200)).toBeNull()
  })
})
