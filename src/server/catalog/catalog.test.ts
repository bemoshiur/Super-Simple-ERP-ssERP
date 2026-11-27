import { describe, expect, it } from 'vitest'
import { nextSku, skuPrefix } from './sku'
import { productSchema, taxonSchema } from './schemas'

describe('sku suggestion', () => {
  it('builds a short prefix from the name', () => {
    expect(skuPrefix('iPhone 15 Pro')).toBe('I1P')
    expect(skuPrefix('Charger')).toBe('CHAR')
    expect(skuPrefix('  ')).toBe('PRD')
    expect(skuPrefix('মোবাইল ফোন')).toBe('PRD') // Bengali-only falls back
  })
  it('increments past the highest existing number, case-insensitively', () => {
    expect(nextSku('IPH', [])).toBe('IPH-0001')
    expect(nextSku('IPH', ['IPH-0001', 'iph-0007', 'IPH-X', 'OTHER-0099'])).toBe('IPH-0008')
    expect(nextSku('A.B', ['AXB-0005'])).toBe('A.B-0001') // regex metacharacters are escaped
  })
})

describe('productSchema', () => {
  const base = { name: ' Galaxy A15 ', sku: ' gal-001 ' }
  it('normalises and applies defaults', () => {
    const p = productSchema.parse(base)
    expect(p).toMatchObject({ name: 'Galaxy A15', sku: 'GAL-001', trackSerial: false, warrantyMonths: 0, purchasePrice: '0.00', salePrice: '0.00', lowStockThreshold: 0, categoryId: null, brandId: null })
  })
  it('parses money exactly, with lakh grouping', () => {
    const p = productSchema.parse({ ...base, purchasePrice: '12,50,000.5', salePrice: '0.1' })
    expect(p.purchasePrice).toBe('1250000.50')
    expect(p.salePrice).toBe('0.10')
  })
  it('rejects bad money, negatives and absurd sizes', () => {
    expect(productSchema.safeParse({ ...base, purchasePrice: '12abc' }).success).toBe(false)
    expect(productSchema.safeParse({ ...base, salePrice: '-5' }).success).toBe(false)
    expect(productSchema.safeParse({ ...base, salePrice: '9999999999999' }).success).toBe(false)
    expect(productSchema.safeParse({ ...base, warrantyMonths: '-1' }).success).toBe(false)
    expect(productSchema.safeParse({ ...base, warrantyMonths: '12.5' }).success).toBe(false)
  })
  it('validates required name, sku shape and ids', () => {
    expect(productSchema.safeParse({ name: '', sku: 'A' }).success).toBe(false)
    expect(productSchema.safeParse({ name: 'x', sku: 'bad sku!' }).success).toBe(false)
    expect(productSchema.safeParse({ ...base, categoryId: 'nope' }).success).toBe(false)
    expect(productSchema.parse({ ...base, categoryId: '' }).categoryId).toBeNull()
  })
  it('has no `active` field: payloads cannot set it', () => {
    expect('active' in productSchema.parse({ ...base, active: false })).toBe(false)
  })
  it('ignores a client-supplied companyId', () => {
    const p = productSchema.parse({ ...base, companyId: '00000000-0000-4000-8000-000000000000' }) as Record<string, unknown>
    expect('companyId' in p).toBe(false)
  })
})

describe('taxonSchema', () => {
  it('requires a trimmed name', () => {
    expect(taxonSchema.parse({ name: '  Phones ' }).name).toBe('Phones')
    expect(taxonSchema.safeParse({ name: '   ' }).success).toBe(false)
  })
})
