import { BarcodeFormat, BinaryBitmap, DecodeHintType, HybridBinarizer, MultiFormatReader, RGBLuminanceSource } from '@zxing/library'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import LabelSheet, { labelCss } from '@/app/(print)/serials/labels/LabelSheet'
import { LABEL_LAYOUTS, LAYOUT_ORDER, MAX_LABELS, code128Path, labelQuery, parseLabelParams, qrPath, truncateLabel } from './pure'

/** Rasterise an SVG path made of axis-aligned unit rectangles ("M x y h w v h h -w z") and decode it with ZXing: a true round trip. */
function decodePath(d: string, w: number, h: number, scaleX: number, scaleY: number, format: BarcodeFormat): string {
  const W = w * scaleX
  const H = h * scaleY
  const px = new Uint8ClampedArray(W * H).fill(255)
  for (const m of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    const [x, y, len] = [Number(m[1]), Number(m[2]), Number(m[3])]
    for (let yy = y * scaleY; yy < (y + 1) * scaleY; yy++) for (let xx = x * scaleX; xx < (x + len) * scaleX; xx++) px[yy * W + xx] = 0
  }
  const reader = new MultiFormatReader()
  reader.setHints(new Map<DecodeHintType, unknown>([[DecodeHintType.POSSIBLE_FORMATS, [format]], [DecodeHintType.TRY_HARDER, true]]))
  return reader.decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(px, W, H)))).getText()
}

describe('QR + Code 128 symbologies', () => {
  it.each(['HIK123456789', '356789012345678', 'SN/2026-11:ab_c.d', 'সিরিয়াল-০০১', 'a'.repeat(64)])('QR decodes back to exactly the serial %s', (serial) => {
    const qr = qrPath(serial)
    expect(decodePath(qr.d, qr.size, qr.size, 6, 6, BarcodeFormat.QR_CODE)).toBe(serial)
  })
  it.each(['HIK123456789', '356789012345678', 'ab-CD_09.x', 'A'.repeat(40)])('Code 128 decodes back to exactly the serial %s', (serial) => {
    const bc = code128Path(serial)!
    // bars are 1 module tall in the path; give the raster some height so a scan line exists
    const d = bc.d.replace(/M(\d+) 0h(\d+)v1h-\d+z/g, (_m, x, len) => Array.from({ length: 8 }, (_, y) => `M${x} ${y}h${len}v1h-${len}z`).join(''))
    expect(decodePath(d, bc.width, 8, 3, 4, BarcodeFormat.CODE_128)).toBe(serial)
  })
  it('Code 128 is only for printable ASCII; Bengali serials get QR only', () => {
    expect(code128Path('সিরিয়াল')).toBeNull()
    expect(code128Path('')).toBeNull()
    expect(code128Path('has\ttab')).toBeNull()
  })
})

describe('truncateLabel', () => {
  it('shortens by code points with an ellipsis and never splits a Bengali conjunct or emoji pair', () => {
    expect(truncateLabel('Hikvision DS-2CE16D0T-IRPF 2MP Bullet Camera', 20)).toBe('Hikvision DS-2CE16D…')
    expect(truncateLabel('  short   name ', 20)).toBe('short name')
    const bn = truncateLabel('হিকভিশন ক্যামেরা ২ মেগাপিক্সেল বুলেট', 10)
    expect([...bn]).toHaveLength(10)
    expect(bn.endsWith('…')).toBe(true)
    expect([...truncateLabel('😀😀😀😀😀😀', 4)]).toHaveLength(4)
  })
})

const U1 = '11111111-1111-4111-8111-111111111111'
const U2 = '22222222-2222-4222-8222-222222222222'
describe('parseLabelParams', () => {
  it('purchase wins; ids are filtered to uuids, deduped and capped; defaults are A4 / no barcode', () => {
    expect(parseLabelParams({ purchase: U1, ids: U2 })).toEqual({ source: 'purchase', purchaseId: U1, valid: true, layout: 'a4', barcode: false })
    expect(parseLabelParams({ purchase: 'nope' })).toMatchObject({ source: 'purchase', valid: false })
    expect(parseLabelParams({ ids: `${U1}, ${U2},${U1},not-a-uuid,'; drop table`, layout: '58', barcode: '1' })).toEqual({ source: 'ids', ids: [U1, U2], layout: '58', barcode: true, tooMany: false })
    const many = Array.from({ length: MAX_LABELS + 5 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`).join(',')
    const p = parseLabelParams({ ids: many })
    expect(p).toMatchObject({ source: 'ids', tooMany: true })
    expect((p as { ids: string[] }).ids).toHaveLength(MAX_LABELS)
    expect(parseLabelParams({ ids: '' })).toMatchObject({ source: 'stock' })
  })
  it('unknown layout falls back, sku is trimmed, array params use the first value', () => {
    expect(parseLabelParams({ layout: 'huge', sku: '  CAM-1 ' })).toEqual({ source: 'stock', sku: 'CAM-1', layout: 'a4', barcode: false })
    expect(parseLabelParams({ layout: ['50x25', 'a4'] })).toMatchObject({ layout: '50x25' })
  })
  it('labelQuery round-trips', () => {
    const p = parseLabelParams({ purchase: U1, layout: '50x25' })
    expect(parseLabelParams(Object.fromEntries(new URLSearchParams(labelQuery(p, { barcode: true }))))).toEqual({ ...p, barcode: true })
  })
})

const render = (labels: { id: string; serialNo: string; productName: string; sku: string }[], layout: 'a4' | '50x25' | '58', shop: string, barcode: boolean) => renderToStaticMarkup(createElement(LabelSheet, { labels, layout, shop, barcode }))

describe('print CSS + markup', () => {
  it('each layout declares its own @page size', () => {
    expect(labelCss('a4')).toContain('@page { size: A4 portrait; margin: 12.5mm 9.75mm; }')
    expect(labelCss('50x25')).toContain('size: 50mm 25mm')
    expect(labelCss('58')).toContain('size: 58mm 40mm')
    expect([...LAYOUT_ORDER].sort()).toEqual(Object.keys(LABEL_LAYOUTS).sort())
  })
  it('renders text as text (no XSS), truncates the name, shows serial/shop/QR, never a price, and the barcode only on request', () => {
    const evil = '<img src=x onerror=alert(1)>'
    const labels = [{ id: 'u1', serialNo: '<script>alert(1)</script>', productName: `${evil} ${'x'.repeat(80)}`, sku: 'S' }]
    const html = render(labels, 'a4', `${evil} Shop`, false)
    expect(html).not.toContain('<script>alert')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('class="lbl-qr"')
    expect(html).not.toContain('class="lbl-bar"')
    expect(html).toContain('…')
    expect(html).not.toMatch(/৳|price|cost/i)
    // Code 128 cannot hold this serial's... it can (ASCII), so the barcode shows when asked for
    expect(render(labels, '58', "S", true)).toContain('class="lbl-bar"')
    // Bengali: QR only, no barcode, no crash
    const bn = render([{ id: 'u2', serialNo: 'সিরিয়াল-১', productName: 'ক্যামেরা', sku: 'B' }], '50x25', "দোকান", true)
    expect(bn).toContain('class="lbl-qr"')
    expect(bn).not.toContain('class="lbl-bar"')
  })
})
