import { describe, expect, it } from 'vitest'
import { diffRows, displayValue, historyRows, humanKey, MAX_VALUE_CHARS } from './diff'

describe('activity diff rendering', () => {
  it('formats values as plain text and truncates huge ones', () => {
    expect(displayValue(null)).toBe('—')
    expect(displayValue(['a', 'b'])).toBe('a, b')
    expect(displayValue({ x: 1 })).toBe('{"x":1}')
    const s = displayValue('x'.repeat(5000))
    expect(s.length).toBe(MAX_VALUE_CHARS)
    expect(s.endsWith('…')).toBe(true)
    // markup is just text: React escapes it; nothing here produces HTML
    expect(displayValue('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>')
  })
  it('humanises keys', () => {
    expect(humanKey('openingBalance')).toBe('Opening balance')
    expect(humanKey('invoice_prefix_sale')).toBe('Invoice prefix sale')
  })
  it('unions before/after keys and flags changes', () => {
    expect(diffRows({ name: 'A', active: true }, { name: 'B', active: true, role: 'x' })).toEqual([
      { key: 'Name', before: 'A', after: 'B', changed: true },
      { key: 'Active', before: 'true', after: 'true', changed: false },
      { key: 'Role', before: '', after: 'x', changed: false },
    ])
    expect(diffRows(null, 'scalar')).toEqual([{ key: 'Value', before: '', after: 'scalar', changed: false }])
    expect(diffRows(undefined, undefined)).toEqual([])
  })
  it('reads record_history {field:{from,to}}', () => {
    expect(historyRows({ salePrice: { from: '10.00', to: '12.00' } })).toEqual([{ key: 'Sale price', before: '10.00', after: '12.00', changed: true }])
    expect(historyRows('odd')).toEqual([{ key: 'Change', before: '', after: 'odd', changed: true }])
  })
})
