import { describe, expect, it } from 'vitest'
import { formatDocNumber } from '../docnumbers'
import { purchaseSchema, vendorPaymentSchema } from './schemas'
import { MAX_UNITS_PER_INVOICE, formatSerialList, normalizeSerial, parseSerialText, serialProblem, serialsFromCsv } from './serialInput'
import { allocateDiscount, computePurchaseTotals, displayStatus, settle, splitEvenly } from './totals'

describe('serial text parsing', () => {
  it('splits on newlines, commas and tabs; trims; drops blanks', () => {
    expect(parseSerialText(' A1 \r\nB2,C3\tD4\n\n , \n').serials).toEqual(['A1', 'B2', 'C3', 'D4'])
  })
  it('strips BOM and zero-width characters', () => {
    expect(parseSerialText('﻿IMEI1​\nIM‍EI2⁠').serials).toEqual(['IMEI1', 'IMEI2'])
    expect(normalizeSerial('­X‌ ')).toBe('X')
  })
  it('is case-sensitive but reports case-only duplicates', () => {
    const r = parseSerialText('abc1\nABC1\nxyz')
    expect(r.serials).toEqual(['abc1', 'ABC1', 'xyz'])
    expect(r.caseOnly).toEqual([['abc1', 'ABC1']])
    expect(r.duplicates).toEqual([])
  })
  it('reports exact duplicates once and keeps the first', () => {
    const r = parseSerialText('S1\nS2\nS1\nS1')
    expect(r.serials).toEqual(['S1', 'S2'])
    expect(r.duplicates).toEqual(['S1'])
  })
  it('flags too-long and non-printable values', () => {
    const r = parseSerialText(`${'x'.repeat(65)}\nok\nbad\u0007bell`)
    expect(r.serials).toEqual(['ok'])
    expect(r.invalid.map((i) => i.reason)).toEqual(['longer than 64 characters', 'contains spaces or non-printable characters'])
    expect(serialProblem('x'.repeat(64))).toBeNull()
    expect(serialProblem('has space')).not.toBeNull()
    expect(serialProblem('বাংলা-১২৩')).toBeNull() // printable unicode is allowed
  })
})

describe('CSV import', () => {
  it('single column', () => expect(serialsFromCsv('A\r\nB\n\nC')).toBe('A\nB\nC'))
  it('uses the serial column of a header row', () => {
    expect(serialsFromCsv('product,Serial,cost\nPhone,"S,1",10\nPhone, S2 ,10')).toBe('S,1\nS2')
    expect(serialsFromCsv('﻿IMEI\n123\n456')).toBe('123\n456')
  })
  it('without a header takes the first column', () => expect(serialsFromCsv('X1,foo\nX2,bar')).toBe('X1\nX2'))
})

describe('formatSerialList', () => {
  it('caps at 20 with "and N more"', () => {
    const list = Array.from({ length: 23 }, (_, i) => `S${i + 1}`)
    expect(formatSerialList(list)).toBe(`${list.slice(0, 20).join(', ')} and 3 more`)
    expect(formatSerialList(['a', 'b'])).toBe('a, b')
  })
})

describe('purchase totals (exact minor units)', () => {
  it('sums lines, subtracts discount and paid', () => {
    const r = computePurchaseTotals({ items: [{ qty: 3, unitCost: '0.10' }, { qty: '2', unitCost: '1,250.35' }], discount: '0.20', paid: '1000' })
    expect(r).toEqual({ ok: true, totals: { lines: ['0.30', '2500.70'], netLines: ['0.30', '2500.50'], subtotal: '2501.00', discount: '0.20', total: '2500.80', paid: '1000.00', due: '1500.80' } })
  })
  it('accepts lakh grouping and blank discount/paid', () => {
    const r = computePurchaseTotals({ items: [{ qty: 1, unitCost: '12,34,567.50' }] })
    expect(r.ok && r.totals).toMatchObject({ total: '1234567.50', paid: '0.00', due: '1234567.50' })
  })
  it('rejects discount over subtotal, paid over total, negatives, junk', () => {
    expect(computePurchaseTotals({ items: [{ qty: 1, unitCost: '10' }], discount: '10.01' })).toMatchObject({ ok: false, errors: { discount: expect.any(String) } })
    expect(computePurchaseTotals({ items: [{ qty: 1, unitCost: '10' }], discount: '1', paid: '9.01' })).toMatchObject({ ok: false, errors: { paid: expect.any(String) } })
    expect(computePurchaseTotals({ items: [{ qty: 1, unitCost: '-1' }] })).toMatchObject({ ok: false, errors: { 'items.0.unitCost': expect.any(String) } })
    expect(computePurchaseTotals({ items: [{ qty: 0, unitCost: '1' }] })).toMatchObject({ ok: false, errors: { 'items.0.qty': expect.any(String) } })
    expect(computePurchaseTotals({ items: [{ qty: 1, unitCost: 'abc' }], paid: '-5' })).toMatchObject({ ok: false, errors: { 'items.0.unitCost': expect.any(String), paid: expect.any(String) } })
  })
  it('a fully discounted invoice is allowed (total 0)', () => {
    expect(computePurchaseTotals({ items: [{ qty: 1, unitCost: '5' }], discount: '5' })).toMatchObject({ ok: true, totals: { total: '0.00', due: '0.00' } })
  })
})

describe('settle', () => {
  it('due/status from total, returns and net paid', () => {
    expect(settle({ total: '100', returned: '0', paid: '0' })).toEqual({ due: '100.00', status: 'received', excess: '0.00' })
    expect(settle({ total: '100', returned: '0', paid: '40' })).toEqual({ due: '60.00', status: 'partially_paid', excess: '0.00' })
    expect(settle({ total: '100', returned: '30', paid: '70' })).toEqual({ due: '0.00', status: 'paid', excess: '0.00' })
    expect(settle({ total: '100', returned: '50', paid: '80' })).toEqual({ due: '0.00', status: 'paid', excess: '30.00' })
  })
})

describe('schemas', () => {
  const base = { vendorId: '00000000-0000-4000-8000-000000000001', date: '2026-11-26', items: [{ productId: '00000000-0000-4000-8000-000000000002', qty: '2', unitCost: '10' }] }
  it('parses a minimal invoice, ignoring client-sent totals', () => {
    const d = purchaseSchema.parse({ ...base, subtotal: '1', total: '1', due: '0' })
    expect(d).toMatchObject({ discount: '0.00', paid: '0.00', accountId: null, items: [{ qty: 2, unitCost: '10.00', serials: [] }] })
    expect(d).not.toHaveProperty('total')
  })
  it('rejects impossible dates, zero qty and more than the unit cap', () => {
    expect(purchaseSchema.safeParse({ ...base, date: '2026-02-30' }).success).toBe(false)
    expect(purchaseSchema.safeParse({ ...base, items: [{ ...base.items[0], qty: 0 }] }).success).toBe(false)
    const over = purchaseSchema.safeParse({ ...base, items: [{ ...base.items[0], qty: MAX_UNITS_PER_INVOICE }, { ...base.items[0], qty: 1 }] })
    expect(over.success).toBe(false)
  })
  it('vendor payment needs a positive amount', () => {
    expect(vendorPaymentSchema.safeParse({ amount: '0', accountId: base.vendorId, date: '2026-11-26' }).success).toBe(false)
    expect(vendorPaymentSchema.parse({ amount: '1,500.5', accountId: base.vendorId, date: '2026-11-26' }).amount).toBe('1500.50')
  })
})

describe('doc numbers', () => {
  it('pads to 5 digits and grows beyond', () => {
    expect(formatDocNumber('PUR-', 7)).toBe('PUR-00007')
    expect(formatDocNumber('PR-', 123456)).toBe('PR-123456')
  })
})

describe('discount allocation (property-style)', () => {
  // Deterministic PRNG so failures are reproducible.
  const rng = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)

  it('shares always sum to the discount, stay within 0..line, for random invoices', () => {
    const r = rng(42)
    for (let n = 0; n < 2000; n++) {
      const count = 1 + Math.floor(r() * 8)
      const lines = Array.from({ length: count }, () => (r() < 0.15 ? 0 : Math.floor(r() * (r() < 0.1 ? 1e13 : 1e7))))
      const subtotal = lines.reduce((a, b) => a + b, 0)
      const discount = r() < 0.1 ? subtotal : Math.floor(r() * (subtotal + 1))
      const shares = allocateDiscount(lines, discount)
      expect(shares.reduce((a, b) => a + b, 0)).toBe(discount)
      shares.forEach((s, i) => {
        expect(Number.isInteger(s)).toBe(true)
        expect(s).toBeGreaterThanOrEqual(0)
        expect(s).toBeLessThanOrEqual(lines[i])
      })
      // every unit's net cost >= 0 and the units of every line add back to the invoice total exactly
      const qtys = lines.map(() => 1 + Math.floor(r() * 5))
      const unitSum = lines.reduce((acc, l, i) => acc + splitEvenly(l - shares[i], qtys[i]).reduce((a, b) => a + b, 0), 0)
      expect(unitSum).toBe(subtotal - discount)
    }
  })

  it('discount == subtotal gives zero everywhere; zero discount changes nothing; single unit gets it all', () => {
    expect(allocateDiscount([300, 700], 1000)).toEqual([300, 700])
    expect(allocateDiscount([300, 700], 0)).toEqual([0, 0])
    expect(allocateDiscount([12345], 345)).toEqual([345])
    expect(splitEvenly(0, 3)).toEqual([0, 0, 0])
  })

  it('largest remainder, ties to the earlier line; extra cents to the first units', () => {
    expect(allocateDiscount([100, 100, 100], 100)).toEqual([34, 33, 33])
    expect(allocateDiscount([1, 2], 1)).toEqual([0, 1]) // remainders 1/3 vs 2/3
    expect(splitEvenly(100, 3)).toEqual([34, 33, 33])
    expect(splitEvenly(5, 1)).toEqual([5])
  })

  it('rejects impossible input', () => {
    expect(() => allocateDiscount([10], 11)).toThrow()
    expect(() => allocateDiscount([10], -1)).toThrow()
    expect(() => splitEvenly(10, 0)).toThrow()
    expect(() => splitEvenly(-1, 1)).toThrow()
  })

  it('computePurchaseTotals exposes net lines that sum to the total', () => {
    const t = computePurchaseTotals({ items: [{ qty: 2, unitCost: '100' }, { qty: 1, unitCost: '0.01' }], discount: '100' })
    expect(t.ok && t.totals).toMatchObject({ total: '100.01', netLines: ['100.00', '0.01'] })
  })
})

describe('displayStatus', () => {
  const st = (total: string, returnedTotal: string, paid: string, due: string) => displayStatus({ total, returnedTotal, paid, due })
  it('fully returned is never "paid"', () => {
    expect(st('100', '100', '0', '0')).toBe('returned')
    expect(st('100', '100', '60', '0')).toBe('returned')
    expect(st('100', '40', '60', '0')).toBe('paid')
    expect(st('100', '40', '10', '50')).toBe('partially_paid')
    expect(st('100', '0', '0', '100')).toBe('unpaid')
    expect(st('0', '0', '0', '0')).toBe('paid')
  })
})
