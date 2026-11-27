/**
 * Label printing, pure part: layouts, URL parameters, text truncation, and the two symbologies as plain SVG path data.
 * The QR payload is the serial number only. Nothing here sees prices or costs: a label has no way to show them.
 */
import JsBarcode from 'jsbarcode'
import qrcode from 'qrcode-generator'

/** Most labels one print job may hold (one HTTP page of units; the page says when the selection was cut). */
export const MAX_LABELS = 500

export type LabelLayoutId = 'a4' | '50x25' | '58'
export type LabelLayout = {
  id: LabelLayoutId
  name: string
  description: string
  /** CSS @page rule for printing this layout. */
  page: string
  /** Max characters of the product name before an ellipsis. */
  nameMax: number
}
export const LABEL_LAYOUTS: Record<LabelLayoutId, LabelLayout> = {
  a4: { id: 'a4', name: 'A4 sheet, 3 x 8', description: '24 labels per A4 page (63.5 x 34 mm each)', page: '@page { size: A4 portrait; margin: 12.5mm 9.75mm; }', nameMax: 34 },
  '50x25': { id: '50x25', name: '50 x 25 mm label', description: 'One label per page for a 50 x 25 mm label printer', page: '@page { size: 50mm 25mm; margin: 0; }', nameMax: 26 },
  '58': { id: '58', name: '58 mm thermal roll', description: 'One label per page, 58 mm wide roll (58 x 40 mm)', page: '@page { size: 58mm 40mm; margin: 0; }', nameMax: 30 },
}
/** Display order (an object with the integer-like key '58' would list it first). */
export const LAYOUT_ORDER: readonly LabelLayoutId[] = ['a4', '50x25', '58']
export const DEFAULT_LAYOUT: LabelLayoutId = 'a4'

export const isLayoutId = (v: unknown): v is LabelLayoutId => typeof v === 'string' && Object.hasOwn(LABEL_LAYOUTS, v)

/** Shorten to `max` characters (counted in code points, so Bengali / emoji are never split), ending in an ellipsis. */
export function truncateLabel(text: string, max: number): string {
  const chars = [...text.trim().replace(/\s+/g, ' ')]
  if (chars.length <= max) return chars.join('')
  return `${chars.slice(0, Math.max(1, max - 1)).join('').trimEnd()}…`
}

// ------------------------------------------------------------------ URL parameters

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export type LabelParams =
  | { source: 'purchase'; purchaseId: string; /** false when ?purchase= was present but is not an id: shown as "not found", never as stock labels. */ valid: boolean; layout: LabelLayoutId; barcode: boolean }
  | { source: 'ids'; ids: string[]; layout: LabelLayoutId; barcode: boolean; tooMany: boolean }
  | { source: 'stock'; sku: string | null; layout: LabelLayoutId; barcode: boolean }

/**
 * ?purchase=<id>  -> units of one purchase invoice
 * ?ids=<id>,<id>  -> these units (uuids; anything else is ignored; max MAX_LABELS)
 * otherwise       -> units in stock, optionally of one product (?sku=)
 * &layout=a4|50x25|58   &barcode=1 adds a Code 128 barcode under the QR code.
 */
export function parseLabelParams(sp: Record<string, string | string[] | undefined>): LabelParams {
  const layoutRaw = first(sp.layout)
  const layout = isLayoutId(layoutRaw) ? layoutRaw : DEFAULT_LAYOUT
  const barcode = first(sp.barcode) === '1'
  const purchase = first(sp.purchase)?.trim()
  if (purchase) return { source: 'purchase', purchaseId: purchase.slice(0, 64), valid: UUID.test(purchase), layout, barcode }
  const idsRaw = first(sp.ids)
  if (idsRaw !== undefined && idsRaw.trim() !== '') {
    const all = [...new Set(idsRaw.split(',').map((x) => x.trim()).filter((x) => UUID.test(x)))]
    return { source: 'ids', ids: all.slice(0, MAX_LABELS), layout, barcode, tooMany: all.length > MAX_LABELS }
  }
  const sku = first(sp.sku)?.trim().slice(0, 100)
  return { source: 'stock', sku: sku || null, layout, barcode }
}

/** Query string that reproduces `p` with a different layout / barcode choice. */
export function labelQuery(p: LabelParams, patch: Partial<Pick<LabelParams, 'layout' | 'barcode'>> = {}): string {
  const q = new URLSearchParams()
  if (p.source === 'purchase') q.set('purchase', p.purchaseId)
  else if (p.source === 'ids') q.set('ids', p.ids.join(','))
  else if (p.sku) q.set('sku', p.sku)
  q.set('layout', patch.layout ?? p.layout)
  if (patch.barcode ?? p.barcode) q.set('barcode', '1')
  return q.toString()
}

// ------------------------------------------------------------------ symbologies as SVG path data

// Serials may be Bengali or other non-Latin text: encode as UTF-8 so any scanner reads back the exact serial.
qrcode.stringToBytes = (text: string) => Array.from(new TextEncoder().encode(text))

export type QrSvg = { /** Modules per side including the quiet zone. */ size: number; /** One path of 1x1 squares. */ d: string }

/** QR code (error correction M, byte mode, 2-module quiet zone) for `payload` as one SVG path in module units. */
export function qrPath(payload: string): QrSvg {
  const qr = qrcode(0, 'M')
  qr.addData(payload, 'Byte')
  qr.make()
  const n = qr.getModuleCount()
  const quiet = 2
  const parts: string[] = []
  for (let r = 0; r < n; r++) {
    let c = 0
    while (c < n) {
      if (!qr.isDark(r, c)) {
        c++
        continue
      }
      const start = c
      while (c < n && qr.isDark(r, c)) c++
      parts.push(`M${start + quiet} ${r + quiet}h${c - start}v1h-${c - start}z`)
    }
  }
  return { size: n + quiet * 2, d: parts.join('') }
}

export type BarcodeSvg = { /** Modules wide including the 10-module quiet zones. */ width: number; d: string }

/** Code 128 for ASCII text as one SVG path (height 1 per module row; scale in CSS); null when the text cannot be encoded. */
export function code128Path(text: string): BarcodeSvg | null {
  if (text === '' || !/^[\x20-\x7e]+$/.test(text)) return null
  const holder: { encodings?: { data: string }[] } = {}
  try {
    JsBarcode(holder, text, { format: 'CODE128' })
  } catch {
    return null
  }
  const bits = (holder.encodings ?? []).map((e) => e.data).join('')
  if (!bits) return null
  const quiet = 10
  const parts: string[] = []
  let i = 0
  while (i < bits.length) {
    if (bits[i] !== '1') {
      i++
      continue
    }
    const start = i
    while (i < bits.length && bits[i] === '1') i++
    parts.push(`M${start + quiet} 0h${i - start}v1h-${i - start}z`)
  }
  return { width: bits.length + quiet * 2, d: parts.join('') }
}
