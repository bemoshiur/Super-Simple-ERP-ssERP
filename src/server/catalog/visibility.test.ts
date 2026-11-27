import { describe, expect, it } from 'vitest'
import { productRowsForClient } from './visibility'

describe('productRowsForClient', () => {
  const rows = [{ id: '1', name: 'Cam', salePrice: '2800.00', purchasePrice: '2000.00' }]
  it('omits the purchasePrice key entirely without profit visibility (nothing in the serialised props)', () => {
    const out = productRowsForClient(rows, false)
    expect(out[0]).not.toHaveProperty('purchasePrice')
    expect(JSON.stringify(out)).not.toMatch(/purchasePrice|2000/)
    expect(out[0]).toEqual({ id: '1', name: 'Cam', salePrice: '2800.00' })
  })
  it('keeps it with profit visibility', () => {
    expect(productRowsForClient(rows, true)[0].purchasePrice).toBe('2000.00')
  })
})
