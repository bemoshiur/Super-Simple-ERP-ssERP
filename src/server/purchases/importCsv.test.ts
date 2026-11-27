import { describe, expect, it } from 'vitest'
import { toCsv } from '../reports/csv'
import {
  ERROR_CSV_COLUMNS,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ROWS,
  decodeCsvBytes,
  detectDelimiter,
  errorCsvRows,
  groupImportRows,
  parseCostCell,
  parseCsv,
  parseImportFile,
  summarizeImport,
  validateImportRows,
  type ImportProduct,
} from './importCsv'

const enc = (s: string) => new TextEncoder().encode(s)
const utf16le = (s: string, bom = true) => {
  const out = new Uint8Array((s.length + (bom ? 1 : 0)) * 2)
  let o = 0
  if (bom) {
    out[o++] = 0xff
    out[o++] = 0xfe
  }
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    out[o++] = c & 0xff
    out[o++] = c >> 8
  }
  return out
}
const utf16be = (s: string, bom = true) => {
  const le = utf16le(s, false)
  const out = new Uint8Array(le.length + (bom ? 2 : 0))
  let o = 0
  if (bom) {
    out[o++] = 0xfe
    out[o++] = 0xff
  }
  for (let i = 0; i < le.length; i += 2) {
    out[o++] = le[i + 1]
    out[o++] = le[i]
  }
  return out
}
const HEAD = 'serial,product_sku,unit_cost'

describe('decodeCsvBytes', () => {
  it('UTF-8 with and without BOM', () => {
    expect(decodeCsvBytes(enc('a,b')).text).toBe('a,b')
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...enc('a,b')])
    expect(decodeCsvBytes(withBom)).toEqual({ text: 'a,b', encoding: 'utf-8' })
  })
  it('UTF-16 LE and BE with BOM (Excel "Unicode Text")', () => {
    expect(decodeCsvBytes(utf16le('সিরিয়াল;sku')).text).toBe('সিরিয়াল;sku')
    expect(decodeCsvBytes(utf16le('x')).encoding).toBe('utf-16le')
    expect(decodeCsvBytes(utf16be('সিরিয়াল;sku')).text).toBe('সিরিয়াল;sku')
    expect(decodeCsvBytes(utf16be('x')).encoding).toBe('utf-16be')
  })
  it('BOM-less UTF-16 is detected from the NUL pattern', () => {
    expect(decodeCsvBytes(utf16le('serial,sku\r\nA,B', false))).toEqual({ text: 'serial,sku\r\nA,B', encoding: 'utf-16le' })
    expect(decodeCsvBytes(utf16be('serial,sku\r\nA,B', false))).toEqual({ text: 'serial,sku\r\nA,B', encoding: 'utf-16be' })
  })
  it('invalid UTF-8 falls back to Windows-1252 instead of throwing', () => {
    const r = decodeCsvBytes(new Uint8Array([0x63, 0x61, 0x66, 0xe9]))
    expect(r).toEqual({ text: 'café', encoding: 'windows-1252' })
  })
})

describe('delimiter + CSV parser', () => {
  it('detects comma, semicolon and tab from the header', () => {
    expect(detectDelimiter(`${HEAD}\nA,B,1`)).toBe(',')
    expect(detectDelimiter('serial;product_sku;unit_cost\nA;B;1,5')).toBe(';')
    expect(detectDelimiter('serial\tproduct_sku\tunit_cost\nA\tB\t1')).toBe('\t')
    expect(detectDelimiter('\n\nserial;sku;cost')).toBe(';')
    // delimiters inside quotes do not count
    expect(detectDelimiter('"a;b;c;d",x,y')).toBe(',')
  })
  it('handles quotes, doubled quotes, CRLF, CR, and newlines inside quotes', () => {
    const recs = parseCsv('a,b,c\r\n"x,1","he said ""hi""",z\r\n"multi\nline",2,3\n4,5,6', ',')
    expect(recs.map((r) => r.cells)).toEqual([
      ['a', 'b', 'c'],
      ['x,1', 'he said "hi"', 'z'],
      ['multi\nline', '2', '3'],
      ['4', '5', '6'],
    ])
    expect(recs.map((r) => r.line)).toEqual([1, 2, 3, 5])
    expect(parseCsv('a,b\rc,d', ',').map((r) => r.cells)).toEqual([['a', 'b'], ['c', 'd']])
  })
  it('drops blank lines, keeps a quoted empty cell, tolerates a missing final newline', () => {
    expect(parseCsv('a,b\n\n   \nc,d\n\n', ',').map((r) => r.cells)).toEqual([['a', 'b'], ['c', 'd']])
    expect(parseCsv('"",x', ',')[0].cells).toEqual(['', 'x'])
  })
  it('an unclosed quote is an error, not silent data loss', () => {
    expect(() => parseCsv('a,"b\nc,d', ',')).toThrow(/never closed/)
  })
})

describe('parseImportFile', () => {
  it('maps aliases, trims, strips zero-width characters, keeps Bengali text', () => {
    const f = parseImportFile(enc(`﻿Serial No , Product-SKU,Unit Cost,Warranty,Remarks\n​HIK1​ ,CAM-1,"12,50,000",12,"হাতে লেখা, নোট"\n`))
    expect(f.fileErrors).toEqual([])
    expect(f.rows).toEqual([{ line: 2, serial: 'HIK1', sku: 'CAM-1', unitCost: '12,50,000', warranty: '12', note: 'হাতে লেখা, নোট', extraCells: false, extraEmpty: true, looksGrouped: false }])
  })
  it('reads semicolon files (Excel in Bangladesh/Europe) and tab files', () => {
    expect(parseImportFile(enc('serial;product_sku;unit_cost\nA1;P;100')).rows[0]).toMatchObject({ serial: 'A1', sku: 'P', unitCost: '100' })
    expect(parseImportFile(enc('serial\tproduct_sku\tunit_cost\nA1\tP\t100')).rows[0]).toMatchObject({ serial: 'A1', unitCost: '100' })
  })
  it('reads UTF-16 LE files with BOM and CRLF lines', () => {
    const f = parseImportFile(utf16le(`serial\tproduct_sku\tunit_cost\r\nBN-১\tP\t100\r\nBN-2\tP\t100\r\n`))
    expect(f.encoding).toBe('utf-16le')
    expect(f.rows.map((r) => r.serial)).toEqual(['BN-১', 'BN-2'])
  })
  it('reports missing required columns, empty file, header only, oversize, too many rows', () => {
    expect(parseImportFile(enc('serial,sku\nA,B')).fileErrors[0]).toMatch(/Missing: unit_cost/)
    expect(parseImportFile(enc('')).fileErrors[0]).toMatch(/empty/)
    expect(parseImportFile(enc(HEAD)).fileErrors[0]).toMatch(/no data rows/)
    expect(parseImportFile(new Uint8Array(MAX_IMPORT_BYTES + 1)).fileErrors[0]).toMatch(/too large/)
    const many = `${HEAD}\n${Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `S${i},P,1`).join('\n')}`
    expect(parseImportFile(enc(many)).fileErrors[0]).toMatch(/at most 5000/)
    expect(parseImportFile(enc(`${HEAD}\n${Array.from({ length: MAX_IMPORT_ROWS }, (_, i) => `S${i},P,1`).join('\n')}`)).rows).toHaveLength(MAX_IMPORT_ROWS)
  })
  it('flags rows with extra values (an unquoted lakh amount)', () => {
    const f = parseImportFile(enc(`${HEAD}\nA,P,12,50,000`))
    expect(f.rows[0].extraCells).toBe(true)
  })
  it('trailing empty cells get their own message (not the quoted-amount hint)', () => {
    const msg = (row: string) => validateImportRows(rowsOf(`${HEAD}\n${row}`), lookups())[0].errors.map((e) => e.message).join(' ')
    expect(msg('S1,CAM-1,100,,')).toMatch(/trailing commas/)
    expect(msg('S1,CAM-1,100,,')).not.toMatch(/quotes/)
    expect(msg('S1,CAM-1,12,50,000')).toMatch(/quotes/)
  })
  it('unquoted grouped amounts are refused, never shifted into other columns', () => {
    const code = (head: string, row: string) => validateImportRows(rowsOf(`${head}\n${row}`), lookups())[0].errors.map((e) => e.code)
    const H3 = HEAD
    const H5 = 'serial,product_sku,unit_cost,warranty_months,note'
    expect(code(H3, 'S1,CAM-1,12,50,000')).toEqual(['too_many_columns'])
    expect(code(H3, 'S1,CAM-1,12,50,000,,')).toEqual(['too_many_columns'])
    expect(code(H3, 'S1,CAM-1,1,234.50')).toEqual(['too_many_columns'])
    // wide header: the shifted row has exactly as many cells as the header, so the shape check catches it
    expect(code(H5, 'S1,CAM-1,12,50,000')).toContain('amount_unquoted')
    expect(code(H5, 'S1,CAM-1,1,234.50')).toContain('amount_unquoted')
    expect(code(H5, 'S1,CAM-1,5,000,')).toContain('amount_unquoted')
    // properly quoted, plain, or a normal warranty next to a small cost: fine
    expect(code(H5, 'S1,CAM-1,"12,50,000",,')).toEqual([])
    expect(code(H5, 'S1,CAM-1,"1,234.50",12,')).toEqual([])
    expect(code(H5, 'S1,CAM-1,500,12,')).toEqual([])
    expect(code(H5, 'S1,CAM-1,2000,12,box')).toEqual([])
    // semicolon and tab files: commas are plain text there, an extra EMPTY cell is not an error
    expect(code('serial;product_sku;unit_cost', 'S1;CAM-1;"12,50,000"')).toEqual([])
    expect(code('serial;product_sku;unit_cost', 'S1;CAM-1;100;;')).toEqual([])
    expect(code('serial\tproduct_sku\tunit_cost', 'S1\tCAM-1\t12,50,000')).toEqual([])
  })
  it('rejects control characters in notes and ambiguous headers', () => {
    const n = validateImportRows(rowsOf('serial,product_sku,unit_cost,note\nS1,CAM-1,1,"line1\nline2"\nS2,CAM-1,1,fine'), lookups())
    expect(n.map((r) => r.errors.map((e) => e.code))).toEqual([['note_invalid'], []])
    expect(parseImportFile(enc('serial,imei,product_sku,unit_cost\nA,B,P,1')).fileErrors[0]).toMatch(/More than one column maps to serial/)
    expect(parseImportFile(enc('serial,sku,product_sku,unit_cost\nA,B,P,1')).fileErrors[0]).toMatch(/product_sku/)
    expect(parseImportFile(enc('serial,product_sku,unit_cost,cost\nA,B,1,2')).fileErrors[0]).toMatch(/unit_cost/)
  })
  it('an unclosed quote is a file error', () => {
    expect(parseImportFile(enc(`${HEAD}\nA,"P,1`)).fileErrors[0]).toMatch(/never closed/)
  })
})

describe('parseCostCell', () => {
  it.each([
    ['2000', '2000.00'],
    ['2,000.5', '2000.50'],
    ['12,50,000', '1250000.00'],
    ['0', '0.00'],
    [' 99.99 ', '99.99'],
  ])('accepts %s', (raw, out) => expect(parseCostCell(raw)).toEqual({ ok: true, value: out }))
  it.each(['', 'abc', '-5', '12,5,000', '1,23', '1.234', '1e3', '৳500', '1 000'])('rejects %j', (raw) => expect(parseCostCell(raw).ok).toBe(false))
})

const products: Record<string, ImportProduct> = {
  'CAM-1': { id: 'p-cam', name: 'HIK Camera', sku: 'CAM-1', trackSerial: true, active: true },
  'CBL-1': { id: 'p-cbl', name: 'HDMI Cable', sku: 'CBL-1', trackSerial: false, active: true },
  'OLD-1': { id: 'p-old', name: 'Old phone', sku: 'OLD-1', trackSerial: true, active: false },
}
const lookups = (existing: string[] = []) => ({ product: (s: string) => products[s], existing: new Set(existing) })
const rowsOf = (csv: string) => parseImportFile(enc(csv)).rows

describe('validateImportRows: classification matrix', () => {
  const codes = (csv: string, existing: string[] = []) => validateImportRows(rowsOf(csv), lookups(existing)).map((r) => r.errors.map((e) => e.code))
  it('flags each problem on its own row and lets valid rows through', () => {
    const out = codes(
      [
        HEAD,
        'OK1,CAM-1,2000', // ok
        'OK2,CAM-1,2,000.50', // unquoted comma in the cost -> extra cells (cost parses 2)
        'NOSKU,NOPE,100', // unknown sku
        'CBLSER,CBL-1,10', // non-serial product
        'OLDSER,OLD-1,10', // inactive
        'OK1,CAM-1,2000', // duplicate in file
        'EXIST,CAM-1,100', // exists in company
        'BADCOST,CAM-1,abc', // invalid cost
        'BAD SERIAL,CAM-1,100', // space in serial
        ',CAM-1,100', // missing serial
        'NOSKUCOL,,100', // missing sku
      ].join('\n'),
      ['EXIST'],
    )
    expect(out).toEqual([
      [],
      ['too_many_columns'],
      ['sku_unknown'],
      ['not_serial'],
      ['inactive'],
      ['duplicate_in_file'],
      ['exists'],
      ['cost_invalid'],
      ['serial_invalid'],
      ['serial_missing'],
      ['sku_missing'],
    ])
  })
  it('a row can have several problems; the first occurrence of a duplicate stays valid', () => {
    const rows = validateImportRows(rowsOf(`${HEAD}\nD1,CAM-1,5\nD1,NOPE,x`), lookups())
    expect(rows[0].errors).toEqual([])
    expect(rows[1].errors.map((e) => e.code)).toEqual(['duplicate_in_file', 'sku_unknown', 'cost_invalid'])
    expect(rows[1].errors[0].message).toMatch(/row 2/)
  })
  it('warranty_months is optional, validated 0..120, empty means the product default', () => {
    const rows = validateImportRows(rowsOf('serial,product_sku,unit_cost,warranty_months\nW1,CAM-1,1,\nW2,CAM-1,1,24\nW3,CAM-1,1,0\nW4,CAM-1,1000,121\nW5,CAM-1,1,x\nW6,CAM-1,1,-1'), lookups())
    expect(rows.map((r) => r.warrantyMonths)).toEqual([null, 24, 0, null, null, null])
    expect(rows.map((r) => r.errors.map((e) => e.code))).toEqual([[], [], [], ['warranty_invalid'], ['warranty_invalid'], ['warranty_invalid']])
  })
  it('over-long notes are rejected, Bengali notes are fine', () => {
    const rows = validateImportRows(rowsOf(`serial,product_sku,unit_cost,note\nN1,CAM-1,1,${'x'.repeat(201)}\nN2,CAM-1,1,নতুন`), lookups())
    expect(rows[0].errors.map((e) => e.code)).toEqual(['note_too_long'])
    expect(rows[1].errors).toEqual([])
  })
  it('serial case is preserved and "abc" / "ABC" are different serials (like the purchase form)', () => {
    const rows = validateImportRows(rowsOf(`${HEAD}\nabc,CAM-1,1\nABC,CAM-1,1`), lookups())
    expect(rows.every((r) => r.errors.length === 0)).toBe(true)
  })
  it('formula-looking cells are data, not formulas (they only matter on the way out, see the error CSV)', () => {
    const rows = validateImportRows(rowsOf(`${HEAD}\n=HYPERLINK("x"),CAM-1,1`), lookups())
    expect(rows[0].errors.map((e) => e.code)).toEqual([])
  })
})

describe('summary, grouping and the error CSV', () => {
  const raw = rowsOf([HEAD, 'A1,CAM-1,2000', 'A2,CAM-1,2000', 'A3,CAM-1,2100.50', 'DUP,CAM-1,1', 'DUP,CAM-1,1', 'X,NOPE,1', 'EX,CAM-1,1', 'C,CBL-1,1'].join('\n'))
  const rows = validateImportRows(raw, lookups(['EX']))
  it('counts rows, products, totals and each problem class', () => {
    expect(summarizeImport(rows)).toEqual({ rows: 8, valid: 4, invalid: 4, products: 1, total: '6101.50', newSerials: 6, duplicatesInFile: 1, alreadyExist: 1, unknownSku: 1, notSerial: 1 })
  })
  it('groups valid rows per (product, unit cost) in first-seen order, keeping serial order', () => {
    expect(groupImportRows(rows)).toEqual([
      { productId: 'p-cam', unitCost: '2000.00', serials: ['A1', 'A2'], serialMeta: [{ warrantyMonths: null, note: null }, { warrantyMonths: null, note: null }] },
      { productId: 'p-cam', unitCost: '2100.50', serials: ['A3'], serialMeta: [{ warrantyMonths: null, note: null }] },
      { productId: 'p-cam', unitCost: '1.00', serials: ['DUP'], serialMeta: [{ warrantyMonths: null, note: null }] },
    ])
  })
  it('the error CSV lists only bad rows with the ORIGINAL cell text and neutralises formula injection', () => {
    const evil = rowsOf(`${HEAD}\n=cmd|' /C calc'!A0,NOPE,@SUM(1)\n+1,NOPE,5`)
    const bad = validateImportRows(evil, lookups())
    const csv = toCsv(ERROR_CSV_COLUMNS, errorCsvRows(bad, new Map(evil.map((r) => [r.line, r]))))
    const lines = csv.replace(/^﻿/, '').trimEnd().split('\r\n')
    expect(lines[0]).toBe('row,serial,product_sku,unit_cost,warranty_months,note,problems')
    expect(lines).toHaveLength(3)
    expect(lines[1]).toContain("'=cmd")
    expect(lines[1]).toContain("'@SUM(1)")
    expect(lines[2]).toContain("'+1")
    expect(lines[1].startsWith('2,')).toBe(true)
  })
})
