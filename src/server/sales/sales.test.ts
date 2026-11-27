import { describe, expect, it } from 'vitest'
import { fromMinor, toMinor } from '../money'
import { displayStatus } from '../purchases/totals'
import { TRANSITIONS, canTransition, eventTypeFor } from '../serials'
import { customerPaymentSchema, saleReturnSchema, saleSchema } from './schemas'
import { allocateOldestFirst, averageUnitCost, computeSaleTotals, lineProfit, returnCredit, settleSale, splitEvenly } from './totals'

const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e'

describe('computeSaleTotals', () => {
  it('exact minor-unit math with discount allocation and payments', () => {
    const r = computeSaleTotals({ items: [{ qty: 1, unitPrice: '2800' }, { qty: 3, unitPrice: '0.10' }], discount: '0.05', payments: ['1000', '800.25'] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.totals).toMatchObject({ subtotal: '2800.30', discount: '0.05', total: '2800.25', paid: '1800.25', due: '1000.00', lines: ['2800.00', '0.30'] })
    // net lines sum exactly to the total
    expect(r.totals.netLines.reduce((a, v) => a + toMinor(v), 0)).toBe(toMinor(r.totals.total))
  })
  it('accepts lakh grouping and zero prices', () => {
    const r = computeSaleTotals({ items: [{ qty: '2', unitPrice: '1,25,000.50' }, { qty: 1, unitPrice: '0' }] })
    expect(r.ok && r.totals.total).toBe('250001.00')
  })
  it('rejects negatives, bad qty, discount > subtotal, overpayment and zero payments', () => {
    const r = computeSaleTotals({ items: [{ qty: 0, unitPrice: '-1' }, { qty: '1.5', unitPrice: 'abc' }], discount: '1', payments: ['0', 'x'] })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(Object.keys(r.errors).sort()).toEqual(['discount', 'items.0.qty', 'items.0.unitPrice', 'items.1.qty', 'items.1.unitPrice', 'payments.0.amount', 'payments.1.amount'].sort())
    const over = computeSaleTotals({ items: [{ qty: 1, unitPrice: '100' }], discount: '10', payments: ['60', '30.01'] })
    expect(over.ok ? null : over.errors).toEqual({ paid: expect.any(String) })
  })
  it('property: net lines always sum to the total and never go negative', () => {
    let seed = 7
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n)
    for (let k = 0; k < 500; k++) {
      const items = Array.from({ length: 1 + rnd(6) }, () => ({ qty: 1 + rnd(5), unitPrice: fromMinor(rnd(10_000_000)) }))
      const sub = items.reduce((a, it) => a + it.qty * toMinor(it.unitPrice), 0)
      const r = computeSaleTotals({ items, discount: fromMinor(sub === 0 ? 0 : rnd(sub + 1)) })
      expect(r.ok).toBe(true)
      if (!r.ok) continue
      expect(r.totals.netLines.reduce((a, v) => a + toMinor(v), 0)).toBe(toMinor(r.totals.total))
      r.totals.netLines.forEach((v, i) => {
        expect(toMinor(v)).toBeGreaterThanOrEqual(0)
        expect(toMinor(v)).toBeLessThanOrEqual(toMinor(r.totals.lines[i]))
      })
    }
  })
})

describe('settleSale / display status', () => {
  it('maps amounts to the stored status', () => {
    expect(settleSale({ total: '100', returned: '0', paid: '0' })).toEqual({ due: '100.00', status: 'completed', excess: '0.00' })
    expect(settleSale({ total: '100', returned: '0', paid: '40' })).toMatchObject({ due: '60.00', status: 'partially_paid' })
    expect(settleSale({ total: '100', returned: '0', paid: '100' })).toMatchObject({ due: '0.00', status: 'paid' })
    expect(settleSale({ total: '100', returned: '30', paid: '70' })).toMatchObject({ due: '0.00', status: 'paid' })
    expect(settleSale({ total: '100', returned: '100', paid: '0' })).toMatchObject({ due: '0.00', status: 'returned' })
    expect(settleSale({ total: '100', returned: '70', paid: '60' })).toMatchObject({ due: '0.00', excess: '30.00' })
  })
  it('display status matches purchases for the same amounts', () => {
    expect(displayStatus({ total: '100.00', returnedTotal: '100.00', paid: '0.00', due: '0.00' })).toBe('returned')
    expect(displayStatus({ total: '100.00', returnedTotal: '0.00', paid: '0.00', due: '100.00' })).toBe('unpaid')
  })
})

describe('averageUnitCost', () => {
  it('rounds half up to the minor unit', () => {
    expect(averageUnitCost(1000, 3, 0)).toBe(333) // 333.33
    expect(averageUnitCost(2000, 3, 0)).toBe(667) // 666.67
    expect(averageUnitCost(5, 2, 0)).toBe(3) // 2.5 -> 3
    expect(averageUnitCost(452_50, 10, 0)).toBe(45_25)
  })
  it('falls back to the product price without usable history', () => {
    expect(averageUnitCost(0, 0, 5000)).toBe(5000)
    expect(averageUnitCost(100, -1, 5000)).toBe(5000)
    expect(averageUnitCost(-100, 2, 5000)).toBe(5000)
  })
  it('is exact for huge values', () => {
    expect(averageUnitCost(99_999_999_999_999, 7, 0)).toBe(Math.round(99_999_999_999_999 / 7))
  })
})

describe('returnCredit', () => {
  it('returning every unit in any steps credits exactly the line net', () => {
    // 100.00 over 3 units -> 33.34, 33.33, 33.33
    expect(returnCredit(10_000, 3, 0, 1)).toBe(3334)
    expect(returnCredit(10_000, 3, 1, 2)).toBe(6666)
    expect(returnCredit(10_000, 3, 0, 3)).toBe(10_000)
    for (let q = 1; q <= 9; q++) for (const net of [0, 1, 99, 10_001, 123_457]) {
      let sum = 0
      for (let r = 0; r < q; r++) sum += returnCredit(net, q, r, 1)
      expect(sum).toBe(net)
      expect(splitEvenly(net, q).reduce((a, b) => a + b, 0)).toBe(net)
    }
  })
  it('rejects over-returns', () => {
    expect(() => returnCredit(100, 2, 2, 1)).toThrow()
    expect(() => returnCredit(100, 2, 0, 0)).toThrow()
  })
})

describe('allocateOldestFirst', () => {
  const inv = [
    { id: 'a', dueMinor: 1000 },
    { id: 'b', dueMinor: 0 },
    { id: 'c', dueMinor: 2500 },
  ]
  it('fills the oldest first and skips settled ones', () => {
    expect(allocateOldestFirst(inv, 1500)).toEqual([
      { id: 'a', amountMinor: 1000 },
      { id: 'c', amountMinor: 500 },
    ])
    expect(allocateOldestFirst(inv, 3500)).toEqual([
      { id: 'a', amountMinor: 1000 },
      { id: 'c', amountMinor: 2500 },
    ])
    expect(allocateOldestFirst(inv, 1)).toEqual([{ id: 'a', amountMinor: 1 }])
  })
  it('rejects more than the total due and non-positive amounts', () => {
    expect(() => allocateOldestFirst(inv, 3501)).toThrow()
    expect(() => allocateOldestFirst(inv, 0)).toThrow()
  })
})

describe('profit', () => {
  it('is net revenue minus cost, exact', () => {
    expect(lineProfit('2800.00', 1, '2000.00')).toBe(80_000)
    expect(lineProfit('99.99', 3, '33.34')).toBe(-3)
  })
})

describe('state machine (sales transitions)', () => {
  it('in_stock -> sold is "sold"; sold -> in_stock / damaged is "sale_returned"', () => {
    expect(canTransition('in_stock', 'sold')).toBe(true)
    expect(eventTypeFor('in_stock', 'sold')).toBe('sold')
    expect(canTransition('sold', 'in_stock') && canTransition('sold', 'damaged')).toBe(true)
    expect(eventTypeFor('sold', 'in_stock')).toBe('sale_returned')
    expect(eventTypeFor('sold', 'damaged')).toBe('sale_returned')
    for (const from of ['sold', 'returned_to_vendor', 'damaged'] as const) expect(canTransition(from, 'sold')).toBe(false)
    expect(TRANSITIONS.returned_to_vendor).toEqual([])
  })
})

describe('sale schemas', () => {
  const base = { date: '2026-11-26', items: [{ serial: 'HIK123456789', qty: 1, unitPrice: '2800' }] }
  it('accepts a scanned line and a product line; walk-in by default', () => {
    const d = saleSchema.parse({ ...base, items: [...base.items, { productId: uuid, qty: '2', unitPrice: '1,000' }], payments: [{ accountId: uuid, amount: '10' }] })
    expect(d.customerId).toBeNull()
    expect(d.items[1]).toMatchObject({ productId: uuid, qty: 2, unitPrice: '1000.00' })
  })
  it('a line needs exactly one of serial / product; serial lines are qty 1; price >= 0', () => {
    const issues = (v: unknown) => {
      const r = saleSchema.safeParse(v)
      return r.success ? [] : r.error.issues.map((i) => i.path.join('.'))
    }
    expect(issues({ ...base, items: [{ qty: 1, unitPrice: '1' }] })).toContain('items.0.productId')
    expect(issues({ ...base, items: [{ serial: 'X', productId: uuid, qty: 1, unitPrice: '1' }] })).toContain('items.0.productId')
    expect(issues({ ...base, items: [{ serial: 'X', qty: 2, unitPrice: '1' }] })).toContain('items.0.qty')
    expect(issues({ ...base, items: [{ serial: 'X', qty: 1, unitPrice: '-1' }] })).toContain('items.0.unitPrice')
    expect(issues({ ...base, payments: [{ accountId: uuid, amount: '0' }] })).toContain('payments.0.amount')
    expect(issues({ ...base, idempotencyKey: 'not-a-uuid' })).toContain('idempotencyKey')
    expect(issues({ ...base, date: '2026-02-30' })).toContain('date')
  })
  it('payment and return schemas', () => {
    expect(customerPaymentSchema.safeParse({ amount: '0', accountId: uuid, date: '2026-11-26' }).success).toBe(false)
    expect(saleReturnSchema.parse({ items: [{ saleItemId: uuid, qty: 1 }], date: '2026-11-26' }).items[0].restock).toBe('in_stock')
    expect(saleReturnSchema.safeParse({ items: [], date: '2026-11-26' }).success).toBe(false)
  })
})

describe('fix round 1: request hash and dates', () => {
  it('saleRequestHash ignores line/payment order and changes with any amount', async () => {
    const { saleRequestHash } = await import('./sales')
    const base = { customerId: 'c', discount: '0.00', items: [{ qty: 1, unitPrice: '10.00', productId: null }, { qty: 2, unitPrice: '5.00', productId: 'p' }], payments: [{ accountId: 'a', amount: '1.00' }, { accountId: 'b', amount: '2.00' }] }
    const h = saleRequestHash(base, ['S1', null])
    expect(saleRequestHash({ ...base, items: [...base.items].reverse(), payments: [...base.payments].reverse() }, [null, 'S1'])).toBe(h)
    expect(saleRequestHash({ ...base, discount: '0.01' }, ['S1', null])).not.toBe(h)
    expect(saleRequestHash(base, ['S2', null])).not.toBe(h)
    expect(saleRequestHash({ ...base, customerId: null }, ['S1', null])).not.toBe(h)
  })
  it('addDays is plain calendar arithmetic', async () => {
    const { addDays } = await import('../dates')
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01')
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
  })
})
