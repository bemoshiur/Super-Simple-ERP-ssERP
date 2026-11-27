import type { LabelUnit } from '@/server/labels/labels'
import { LABEL_LAYOUTS, code128Path, qrPath, truncateLabel, type LabelLayoutId } from '@/server/labels/pure'

/** Print CSS for one layout. Sizes are in mm so what you see on screen is the printed size. */
export const labelCss = (layout: LabelLayoutId): string => `
${LABEL_LAYOUTS[layout].page}
.lbl-root { color: #000; background: #fff; font-family: system-ui, -apple-system, 'Noto Sans Bengali', 'Segoe UI', sans-serif; }
.lbl { box-sizing: border-box; overflow: hidden; padding: 2mm; display: flex; flex-direction: column; gap: 0.8mm; break-inside: avoid; page-break-inside: avoid; background: #fff; }
.lbl-main { display: flex; gap: 2mm; align-items: center; flex: 1 1 auto; min-height: 0; }
.lbl-qr { flex: none; width: var(--qr); height: var(--qr); }
.lbl-text { min-width: 0; flex: 1 1 auto; }
.lbl-shop { font-size: 6.5pt; opacity: 0.8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lbl-name { font-size: 8pt; font-weight: 600; line-height: 1.15; max-height: 2.35em; overflow: hidden; overflow-wrap: anywhere; }
.lbl-serial { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 8pt; line-height: 1.15; overflow-wrap: anywhere; margin-top: 0.4mm; }
.lbl-bar { flex: none; display: block; width: 100%; height: var(--bar); }
.l-a4 { display: grid; grid-template-columns: repeat(3, 63.5mm); grid-auto-rows: 34mm; width: 190.5mm; --qr: 19mm; --bar: 6mm; }
.l-a4 .lbl { width: 63.5mm; height: 34mm; }
.l-50x25 { --qr: 13.5mm; --bar: 5mm; }
.l-50x25 .lbl { width: 50mm; height: 25mm; padding: 1.5mm; gap: 0.5mm; }
.l-50x25 .lbl-shop { font-size: 5pt; }
.l-50x25 .lbl-name { font-size: 6pt; }
.l-50x25 .lbl-serial { font-size: 6.5pt; }
.l-58 { --qr: 20mm; --bar: 8mm; }
.l-58 .lbl { width: 58mm; height: 40mm; padding: 2.5mm; }
.l-58 .lbl-serial { font-size: 9pt; }
.l-58 .lbl-name { font-size: 9pt; }
@media screen {
  .lbl-sheet { gap: 0; }
  .l-50x25, .l-58 { display: flex; flex-wrap: wrap; gap: 4mm; }
  .lbl { outline: 1px dashed #aab; }
}
@media print {
  html, body { background: #fff !important; margin: 0 !important; }
  .no-print { display: none !important; }
  .l-50x25, .l-58 { display: block; }
  .l-50x25 .lbl, .l-58 .lbl { page-break-after: always; break-after: page; outline: none; }
  .l-50x25 .lbl:last-child, .l-58 .lbl:last-child { page-break-after: auto; break-after: auto; }
  .lbl { outline: none; }
}
`

const Qr = ({ serial }: { serial: string }) => {
  const qr = qrPath(serial)
  return (
    <svg className="lbl-qr" viewBox={`0 0 ${qr.size} ${qr.size}`} shapeRendering="crispEdges" role="img" aria-label={`QR code of ${serial}`}>
      <path d={qr.d} fill="#000" />
    </svg>
  )
}

const Bar = ({ serial }: { serial: string }) => {
  const bc = code128Path(serial)
  if (!bc) return null
  return (
    <svg className="lbl-bar" viewBox={`0 0 ${bc.width} 1`} preserveAspectRatio="none" shapeRendering="crispEdges" role="img" aria-label={`Barcode of ${serial}`}>
      <path d={bc.d} fill="#000" />
    </svg>
  )
}

/** Server-rendered labels (no client JS). All text goes through React, so serials and names can never inject markup. */
const LabelSheet = ({ labels, layout, shop, barcode }: { labels: LabelUnit[]; layout: LabelLayoutId; shop: string; barcode: boolean }) => (
  <div className="lbl-root">
    <style>{labelCss(layout)}</style>
    <div className={`lbl-sheet l-${layout}`}>
      {labels.map((l) => (
        <div className="lbl" key={l.id}>
          <div className="lbl-main">
            <Qr serial={l.serialNo} />
            <div className="lbl-text">
              <div className="lbl-shop">{shop}</div>
              <div className="lbl-name">{truncateLabel(l.productName, LABEL_LAYOUTS[layout].nameMax)}</div>
              <div className="lbl-serial">{l.serialNo}</div>
            </div>
          </div>
          {barcode && <Bar serial={l.serialNo} />}
        </div>
      ))}
    </div>
  </div>
)

export default LabelSheet
