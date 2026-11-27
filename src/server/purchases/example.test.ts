import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseImportFile, validateImportRows, type ImportProduct } from './importCsv'

const root = path.resolve(import.meta.dirname, '../../..')
const doc = readFileSync(path.join(root, 'docs/examples/serials-import.csv'))

describe('docs/examples/serials-import.csv', () => {
  it('is served unchanged from public/examples and parses cleanly against its three SKUs', () => {
    expect(readFileSync(path.join(root, 'public/examples/serials-import.csv')).equals(doc)).toBe(true)
    const f = parseImportFile(new Uint8Array(doc))
    expect(f.fileErrors).toEqual([])
    const prods: Record<string, ImportProduct> = Object.fromEntries(['CAM-HIK-2MP', 'PHN-REDMI-13C', 'RTR-TPL-C6'].map((sku) => [sku, { id: sku, name: sku, sku, trackSerial: true, active: true }]))
    const rows = validateImportRows(f.rows, { product: (s) => prods[s], existing: new Set() })
    expect(rows).toHaveLength(5)
    expect(rows.flatMap((r) => r.errors)).toEqual([])
    expect(rows[2].unitCost).toBe('12500.00')
    expect(rows[4].serial).toBe('সিরিয়াল-০০১')
  })
})
