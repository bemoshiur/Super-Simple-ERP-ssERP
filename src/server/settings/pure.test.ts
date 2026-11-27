import { describe, expect, it } from 'vitest'
import { formatDocNumber } from '../docnumbers'
import { currencySymbolField, docPrefixField, safeLogoUrl, settingsSchema } from './pure'

describe('safeLogoUrl', () => {
  it.each([
    ['https://cdn.example.com/logo.png', 'https://cdn.example.com/logo.png'],
    [' /uploads/logo.png ', '/uploads/logo.png'],
    ['/logo.svg?v=2', '/logo.svg?v=2'],
  ])('accepts %j', (v, out) => expect(safeLogoUrl(v)).toBe(out))
  it.each(['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:image/svg+xml;base64,PHN2Zz4=', 'http://example.com/a.png', '//evil.com/a.png', '/\\evil.com', 'https://user:pw@example.com/a.png', 'logo.png', 'https://a.com/x".png', 'vbscript:x', '/a b.png', ''])(
    'rejects %j',
    (v) => expect(safeLogoUrl(v)).toBeNull(),
  )
})

describe('document prefixes', () => {
  it('upper-cases and accepts 1..10 of A-Z 0-9 - _', () => {
    expect(docPrefixField.parse(' inv- ')).toBe('INV-')
    expect(docPrefixField.parse('S_R')).toBe('S_R')
  })
  it.each(['', 'ABCDEFGHIJK', 'IN V', 'INV/', 'INV৳', 'INV1', '2026'])('rejects %j', (v) => expect(docPrefixField.safeParse(v).success).toBe(false))
  it('a non-digit last character makes prefix+number unambiguous across prefix changes', () => {
    // With digit-ending prefixes "A1"+5 and "A"+100005 would collide; the rule rules that out.
    expect(formatDocNumber('A1', 5)).toBe(formatDocNumber('A', 100005))
    expect(docPrefixField.safeParse('A1').success).toBe(false)
  })
})

describe('currency symbol', () => {
  it('1..5 characters, no markup', () => {
    expect(currencySymbolField.parse(' ৳ ')).toBe('৳')
    expect(currencySymbolField.parse('BDT')).toBe('BDT')
    expect(currencySymbolField.safeParse('').success).toBe(false)
    expect(currencySymbolField.safeParse('TAKA$$').success).toBe(false)
    expect(currencySymbolField.safeParse('<b>').success).toBe(false)
  })
})

describe('settingsSchema', () => {
  const base = { companyName: 'Shop', currencySymbol: '৳', prefixSale: 'INV-', prefixPurchase: 'PUR-', prefixSaleReturn: 'SR-', prefixPurchaseReturn: 'PR-', prefixService: 'SVC-' }
  it('blank optional fields become null', () => {
    expect(settingsSchema.parse({ ...base, companyAddress: ' ', companyEmail: '', logoUrl: '' })).toMatchObject({ companyAddress: null, companyEmail: null, logoUrl: null, invoiceFooter: null })
  })
  it('validates email and logo', () => {
    expect(settingsSchema.safeParse({ ...base, companyEmail: 'nope' }).success).toBe(false)
    expect(settingsSchema.safeParse({ ...base, logoUrl: 'javascript:alert(1)' }).success).toBe(false)
    expect(settingsSchema.parse({ ...base, companyEmail: 'Shop@Example.com' }).companyEmail).toBe('shop@example.com')
  })
})
