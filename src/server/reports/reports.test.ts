import { describe, expect, it } from 'vitest'
import { accountSchema, expenseSchema, incomeSchema, transferSchema, voidSchema } from '../accounting/schemas'
import { CSV_BOM, csvCell, toCsv } from './csv'
import { reportToCsv, stripSensitive } from './registry'
import { WEEK_START, agingBucket, bucketLabel, bucketStart, computeCashFlow, computeProfitLoss, groupMovements, isIsoDate, marginPercent, mergeBuckets, movementLabel, parseGroup, parseRange, parseWarrantyDays, reconcileCashFlow, warrantyWindow } from './pure'
import type { ReportResult } from './types'

describe('date ranges', () => {
  it('validates ISO dates strictly', () => {
    expect(isIsoDate('2026-02-28')).toBe(true)
    expect(isIsoDate('2026-02-30')).toBe(false)
    expect(isIsoDate('26-02-01')).toBe(false)
    expect(isIsoDate('1999-12-31')).toBe(false)
    expect(isIsoDate(undefined)).toBe(false)
  })
  it('defaults to month-to-date, swaps a reversed range, clamps absurd ranges', () => {
    expect(parseRange({}, '2026-11-26')).toEqual({ from: '2026-11-01', to: '2026-11-26' })
    expect(parseRange({ from: '2026-11-20', to: '2026-11-05' }, '2026-11-26')).toEqual({ from: '2026-11-05', to: '2026-11-20' })
    expect(parseRange({ from: 'nope', to: '2026-03-15' }, '2026-11-26')).toEqual({ from: '2026-03-01', to: '2026-03-15' })
    const r = parseRange({ from: '2001-01-01', to: '2026-11-26' }, '2026-11-26')
    expect(r.to).toBe('2026-11-26')
    expect(r.from > '2016-01-01').toBe(true)
  })
  it('parses group and warranty days defensively', () => {
    expect(parseGroup('week')).toBe('week')
    expect(parseGroup('year')).toBe('day')
    expect(parseWarrantyDays('90')).toBe(90)
    expect(parseWarrantyDays('7')).toBe(30)
  })
})

describe('bucketing (weeks start on Saturday)', () => {
  it('uses Saturday by default', () => expect(WEEK_START).toBe(6))
  it('day and month buckets', () => {
    expect(bucketStart('2026-11-26', 'day')).toBe('2026-11-26')
    expect(bucketStart('2026-11-26', 'month')).toBe('2026-11-01')
    expect(bucketStart('2026-12-31', 'month')).toBe('2026-12-01')
  })
  it('weeks run Saturday to Friday, across month and year boundaries', () => {
    // 2026-11-21 is a Saturday.
    expect(new Date('2026-11-21T00:00:00Z').getUTCDay()).toBe(6)
    expect(bucketStart('2026-11-21', 'week')).toBe('2026-11-21')
    expect(bucketStart('2026-11-22', 'week')).toBe('2026-11-21') // Sunday
    expect(bucketStart('2026-11-26', 'week')).toBe('2026-11-21') // Thursday
    expect(bucketStart('2026-11-27', 'week')).toBe('2026-11-21') // Friday
    expect(bucketStart('2026-11-28', 'week')).toBe('2026-11-28') // next Saturday
    expect(bucketStart('2027-01-01', 'week')).toBe('2026-12-26') // Friday, previous year's Saturday
  })
  it('honours a configurable week start', () => {
    expect(bucketStart('2026-11-26', 'week', 1)).toBe('2026-11-23') // Monday start
    expect(bucketStart('2026-11-23', 'week', 1)).toBe('2026-11-23')
    expect(bucketStart('2026-11-22', 'week', 0)).toBe('2026-11-22') // Sunday start
  })
  it('labels', () => {
    expect(bucketLabel('2026-11-21', 'week')).toBe('2026-11-21 to 2026-11-27')
    expect(bucketLabel('2026-11-01', 'month')).toBe('2026-11')
    expect(bucketLabel('2026-11-01', 'day')).toBe('2026-11-01')
  })
  it('mergeBuckets zero-fills missing series values and sorts', () => {
    const rows = mergeBuckets({ sales: new Map([['2026-11-02', '10.00'], ['2026-11-01', '5.00']]), returns: new Map([['2026-11-03', '1.00']]) })
    expect(rows.map((r) => r.bucket)).toEqual(['2026-11-01', '2026-11-02', '2026-11-03'])
    expect(rows[2].values).toEqual({ sales: '0.00', returns: '1.00' })
  })
})

describe('aging, warranty windows, margin', () => {
  it('buckets by age in days', () => {
    expect([-3, 0, 29, 30, 59, 60, 89, 90, 400].map(agingBucket)).toEqual(['current', 'current', 'current', '30', '30', '60', '60', '90+', '90+'])
  })
  it('warranty windows', () => {
    expect([0, 30, 31, 60, 61, 90, 91].map(warrantyWindow)).toEqual([30, 30, 60, 60, 90, 90, null])
  })
  it('margin percent is exact and null without revenue', () => {
    expect(marginPercent('800.00', '2800.00')).toBe('28.57')
    expect(marginPercent('-100.00', '400.00')).toBe('-25.00')
    expect(marginPercent('0.00', '400.00')).toBe('0.00')
    expect(marginPercent('5.00', '0.00')).toBeNull()
    expect(marginPercent('1.00', '3.00')).toBe('33.33')
  })
})

describe('profit and loss', () => {
  const base = { grossSales: '5600.00', discounts: '200.00', salesReturns: '2700.00', cogs: '4000.00', cogsRestocked: '2000.00', expenses: [{ name: 'Rent', amount: '250.50' }, { name: 'Tea', amount: '49.50' }], otherIncome: [{ name: 'Interest', amount: '100.25' }] }
  it('computes every line exactly', () => {
    const pl = computeProfitLoss(base)
    expect(pl.netSales).toBe('5400.00')
    expect(pl.revenue).toBe('2700.00')
    expect(pl.netCogs).toBe('2000.00')
    expect(pl.grossProfit).toBe('700.00')
    expect(pl.totalExpenses).toBe('300.00')
    expect(pl.totalOtherIncome).toBe('100.25')
    expect(pl.netProfit).toBe('500.25')
  })
  it('purchases are not an input: only sold cost reaches the P&L; an empty period is all zeros', () => {
    const z = computeProfitLoss({ grossSales: '0', discounts: '0', salesReturns: '0', cogs: '0', cogsRestocked: '0', expenses: [], otherIncome: [] })
    expect(z.netProfit).toBe('0.00')
    expect(z.revenue).toBe('0.00')
  })
  it('can go negative and stays exact with cents', () => {
    const pl = computeProfitLoss({ ...base, grossSales: '0.10', discounts: '0.00', salesReturns: '0.00', cogs: '0.20', cogsRestocked: '0.00', expenses: [{ name: 'X', amount: '0.01' }], otherIncome: [] })
    expect(pl.grossProfit).toBe('-0.10')
    expect(pl.netProfit).toBe('-0.11')
  })
  it('damaged returns stay in COGS: only the restocked cost is reversed', () => {
    const pl = computeProfitLoss({ ...base, cogsRestocked: '0.00' })
    expect(pl.netCogs).toBe('4000.00')
    expect(pl.grossProfit).toBe('-1300.00')
  })
  it('stock adjustments are a separate cost line: write-offs reduce gross profit, found stock raises it; COGS lines unchanged', () => {
    const plain = computeProfitLoss(base)
    const w = computeProfitLoss({ ...base, stockAdjustments: '95.00' })
    expect([w.netCogs, w.stockAdjustments, w.totalCost, w.grossProfit, w.netProfit]).toEqual([plain.netCogs, '95.00', '2095.00', '605.00', '405.25'])
    const f = computeProfitLoss({ ...base, stockAdjustments: '-190.00' })
    expect([f.totalCost, f.grossProfit]).toEqual(['1810.00', '890.00'])
    expect(plain.stockAdjustments).toBe('0.00')
  })
})

describe('cash flow', () => {
  const accounts = [
    { id: 'a', name: 'Cash', type: 'cash', openingBalance: '1000.00', beforeIn: '500.00', beforeOut: '200.00', periodIn: '2800.00', periodOut: '300.00' },
    { id: 'b', name: 'Bank', type: 'bank', openingBalance: '0.00', beforeIn: '0.00', beforeOut: '0.00', periodIn: '0.10', periodOut: '0.20' },
  ]
  it('opening + in - out = closing per account and in total', () => {
    const { accounts: rows, totals } = computeCashFlow(accounts)
    expect(rows[0]).toMatchObject({ opening: '1300.00', inflow: '2800.00', outflow: '300.00', closing: '3800.00' })
    expect(rows[1]).toMatchObject({ opening: '0.00', closing: '-0.10' })
    expect(totals).toEqual({ opening: '1300.00', inflow: '2800.10', outflow: '300.20', closing: '3799.90' })
  })
  it('reconciliation detects any difference', () => {
    const { accounts: rows } = computeCashFlow(accounts)
    expect(reconcileCashFlow(rows, [{ id: 'a', balance: '3800.00' }, { id: 'b', balance: '-0.10' }]).ok).toBe(true)
    const bad = reconcileCashFlow(rows, [{ id: 'a', balance: '3800.01' }, { id: 'b', balance: '-0.10' }])
    expect(bad.ok).toBe(false)
    expect(bad.diffs).toEqual([{ id: 'a', closing: '3800.00', balance: '3800.01' }])
    // an account with a balance but missing from the flow is a mismatch too
    expect(reconcileCashFlow(rows, [{ id: 'a', balance: '3800.00' }, { id: 'b', balance: '-0.10' }, { id: 'c', balance: '5.00' }]).ok).toBe(false)
  })
  it('groups movements into labelled lines with exact sums', () => {
    const g = groupMovements([
      { direction: 'in', refType: 'sale', isReversal: false, category: null, amount: '1800.00' },
      { direction: 'in', refType: 'sale', isReversal: false, category: null, amount: '0.10' },
      { direction: 'out', refType: 'purchase', isReversal: false, category: null, amount: '1000.00' },
      { direction: 'out', refType: 'expense', isReversal: false, category: 'Rent', amount: '250.00' },
      { direction: 'in', refType: 'expense', isReversal: true, category: 'Rent', amount: '250.00' },
      { direction: 'in', refType: 'income', isReversal: false, category: null, amount: '5.00' },
      { direction: 'out', refType: 'sale', isReversal: false, category: null, amount: '2200.00' },
    ])
    expect(g.inflows[0]).toEqual({ direction: 'in', label: 'Customer receipts (sales)', amount: '1800.10' })
    expect(g.inflows.map((l) => l.label)).toContain('Void of expense: Rent')
    expect(g.inflows.map((l) => l.label)).toContain('Other income: Uncategorized')
    expect(g.outflows[0].label).toBe('Customer refunds (returns)')
    expect(g.outflows.map((l) => l.label)).toEqual(['Customer refunds (returns)', 'Vendor payments (purchases)', 'Expense: Rent'])
    expect(movementLabel({ direction: 'in', refType: 'transfer', isReversal: false, category: null })).toBe('Transfers in')
  })
})

describe('CSV', () => {
  it('quotes commas, quotes, newlines and surrounding spaces', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"')
    expect(csvCell(' pad ')).toBe('" pad "')
    expect(csvCell(null)).toBe('')
    expect(csvCell(12)).toBe('12')
  })
  it('neutralises formula injection in text cells', () => {
    for (const evil of ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tx', '\rx', '=HYPERLINK("http://x","y")']) {
      const cell = csvCell(evil)
      expect(cell.replace(/^"/, '').startsWith("'")).toBe(true)
    }
    expect(csvCell('=1,2')).toBe('"\'=1,2"')
    expect(csvCell('safe=1')).toBe('safe=1')
  })
  it('neutralises formulas hidden behind leading whitespace (spaces, nbsp, unicode spaces)', () => {
    for (const evil of [' =1+1', '  @cmd', '\u00a0=1', '\u2003+1', '\u3000-1', '\ufeff=1']) expect(csvCell(evil).replace(/^"/, '').startsWith("'"), JSON.stringify(evil)).toBe(true)
    expect(csvCell(' fine')).toBe('" fine"')
    expect(csvCell('a =b')).toBe('a =b')
  })
  it('keeps negative numbers in numeric columns intact but protects the same text in text columns', () => {
    const csv = toCsv([{ key: 'name', label: 'Name' }, { key: 'amt', label: 'Amount', kind: 'money' }], [{ name: '-5', amt: '-12.50' }, { name: '=x', amt: '3.00' }])
    expect(csv).toBe(`${CSV_BOM}Name,Amount\r\n'-5,-12.50\r\n'=x,3.00\r\n`)
  })
  it('starts with a UTF-8 BOM and keeps Bengali text and ৳ unchanged', () => {
    const csv = toCsv([{ key: 'n', label: 'নাম' }], [{ n: 'রহিম, ঢাকা ৳১২' }])
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    expect(csv).toBe(`${CSV_BOM}নাম\r\n"রহিম, ঢাকা ৳১২"\r\n`)
  })
  it('exports multi-table reports with titles and totals, and strips sensitive columns on demand', () => {
    const r: ReportResult = {
      key: 'x', title: 'X', truncated: false, notes: [],
      tables: [
        { title: 'One', columns: [{ key: 'a', label: 'A', kind: 'text' }, { key: 'c', label: 'Cost', kind: 'money', sensitive: true }], rows: [{ a: 'p', c: '5.00' }], totals: { a: 'Total', c: '5.00' } },
        { title: 'Two', columns: [{ key: 'b', label: 'B', kind: 'int' }], rows: [{ b: 2 }] },
      ],
    }
    expect(reportToCsv(r)).toBe(`${CSV_BOM}One\r\nA,Cost\r\np,5.00\r\nTotal,5.00\r\n\r\nTwo\r\nB\r\n2\r\n`)
    const s = stripSensitive(r)
    expect(reportToCsv(s)).not.toContain('Cost')
    expect(reportToCsv(s)).not.toContain('5.00')
    expect(s.tables[0].totals).toEqual({ a: 'Total' })
  })
})

describe('accounting schemas', () => {
  it('account: no `active` field, signed exact opening balance, valid type', () => {
    const ok = accountSchema.parse({ name: ' Cash ', type: 'cash', openingBalance: '1,000.5', active: false })
    expect(ok).toEqual({ name: 'Cash', type: 'cash', openingBalance: '1000.50' })
    expect('active' in ok).toBe(false)
    expect(accountSchema.safeParse({ name: '', type: 'cash' }).success).toBe(false)
    expect(accountSchema.safeParse({ name: 'x', type: 'crypto' }).success).toBe(false)
    expect(accountSchema.parse({ name: 'Overdraft', type: 'bank', openingBalance: '-50' }).openingBalance).toBe('-50.00')
  })
  it('expense/income need a positive amount and a real date', () => {
    const id = '11111111-1111-4111-8111-111111111111'
    expect(expenseSchema.safeParse({ accountId: id, amount: '0', date: '2026-11-01' }).success).toBe(false)
    expect(expenseSchema.safeParse({ accountId: id, amount: '-5', date: '2026-11-01' }).success).toBe(false)
    expect(expenseSchema.safeParse({ accountId: id, amount: '5', date: '2026-02-30' }).success).toBe(false)
    expect(expenseSchema.parse({ accountId: id, amount: '5', date: '2026-11-01', categoryId: '' }).categoryId).toBeNull()
    expect(incomeSchema.parse({ accountId: id, amount: '1,250.5', date: '2026-11-01', category: '  Bank   interest ' })).toMatchObject({ amount: '1250.50', category: 'Bank interest' })
  })
  it('transfer needs two different accounts; void needs a reason', () => {
    const a = '11111111-1111-4111-8111-111111111111'
    const b = '22222222-2222-4222-8222-222222222222'
    expect(transferSchema.safeParse({ fromAccountId: a, toAccountId: a, amount: '5', date: '2026-11-01' }).success).toBe(false)
    expect(transferSchema.safeParse({ fromAccountId: a, toAccountId: b, amount: '5', date: '2026-11-01' }).success).toBe(true)
    expect(voidSchema.safeParse({ reason: '  ' }).success).toBe(false)
  })
})
