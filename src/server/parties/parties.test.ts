import { describe, expect, it } from 'vitest'
import { diffFields } from '../history'
import { computeLedger } from './ledger'
import { partySchema } from './schemas'
import { isUniqueViolation, pgErrorOf } from '../errors'

describe('partySchema', () => {
  it('only the name is required; empty optionals become null', () => {
    const p = partySchema.parse({ name: ' Rahim Traders ', phone: '', email: '', address: '  ' })
    expect(p).toMatchObject({ name: 'Rahim Traders', phone: null, email: null, address: null, notes: null, openingBalance: '0.00' })
  })
  it('accepts BD phone formats incl. Bengali digits, rejects junk', () => {
    expect(partySchema.parse({ name: 'a', phone: '01711-234567' }).phone).toBe('01711-234567')
    expect(partySchema.parse({ name: 'a', phone: '+880 1711 234567' }).phone).toBe('+880 1711 234567')
    expect(partySchema.parse({ name: 'a', phone: '০১৭১১২৩৪৫৬৭' }).phone).toBe('০১৭১১২৩৪৫৬৭')
    expect(partySchema.safeParse({ name: 'a', phone: 'call me' }).success).toBe(false)
  })
  it('lowercases and validates email', () => {
    expect(partySchema.parse({ name: 'a', email: 'Foo@Example.COM' }).email).toBe('foo@example.com')
    expect(partySchema.safeParse({ name: 'a', email: 'nope' }).success).toBe(false)
  })
  it('opening balance is signed and exact', () => {
    expect(partySchema.parse({ name: 'a', openingBalance: '-1,25,000.50' }).openingBalance).toBe('-125000.50')
    expect(partySchema.safeParse({ name: 'a', openingBalance: 'abc' }).success).toBe(false)
  })
})

describe('computeLedger', () => {
  it('due = opening + billed - paid, exactly', () => {
    expect(computeLedger({ opening: '100.10', billed: '0.20', paid: '0.05' })).toMatchObject({ opening: '100.10', billed: '0.20', paid: '0.05', due: '100.25' })
  })
  it('treats SQL nulls as zero and allows an advance (negative due)', () => {
    expect(computeLedger({ opening: null, billed: null, paid: null }).due).toBe('0.00')
    expect(computeLedger({ opening: '0', billed: '500', paid: '800' }).due).toBe('-300.00')
  })
  it('subtracts return credit', () => {
    expect(computeLedger({ opening: '10', billed: '1000', returned: '250.50', paid: '100' })).toMatchObject({ returned: '250.50', due: '659.50' })
  })
})

describe('diffFields', () => {
  it('reports only changed tracked fields and treats ""/undefined as null', () => {
    const d = diffFields({ a: '1.00', b: 'x', c: null, z: 1 }, { a: '2.00', b: 'x', c: '', z: 2 }, ['a', 'b', 'c'])
    expect(d).toEqual({ a: { from: '1.00', to: '2.00' } })
  })
})

describe('error mapping helpers', () => {
  it('finds a pg error through the cause chain', () => {
    const e = new Error('Failed query', { cause: Object.assign(new Error('dup'), { code: '23505', constraint: 'products_company_sku_uq' }) })
    expect(pgErrorOf(e)?.code).toBe('23505')
    expect(isUniqueViolation(e, 'products_company_sku_uq')).toBe(true)
    expect(isUniqueViolation(e, 'other')).toBe(false)
    expect(isUniqueViolation(new Error('x'))).toBe(false)
  })
})
