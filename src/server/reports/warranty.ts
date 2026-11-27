import { listWarrantyExpiring } from '../lookup/lookup'
import { warrantyWindow } from './pure'
import type { ReportContext, ReportParams, ReportResult } from './types'

/** Warranties ending within the next 30/60/90 days (sold units only), soonest first. Thin report over listWarrantyExpiring(). */
export async function warrantyReport(ctx: ReportContext, p: ReportParams): Promise<ReportResult> {
  const rows = await listWarrantyExpiring(ctx.db, ctx.companyId, ctx.branch, p.days, { today: ctx.today, limit: ctx.limit + 1 })
  return {
    key: 'warranty',
    title: `Warranty expiring in the next ${p.days} days`,
    truncated: rows.length > ctx.limit,
    notes: [`Sold units whose warranty ends between ${ctx.today} and ${p.days} days from now. Units that are back in stock, in service or damaged are not listed.`],
    tables: [
      {
        columns: [
          { key: 'serialNo', label: 'Serial / IMEI', kind: 'text' },
          { key: 'productName', label: 'Product', kind: 'text' },
          { key: 'customerName', label: 'Customer', kind: 'text' },
          { key: 'customerPhone', label: 'Phone', kind: 'text' },
          { key: 'invoiceNo', label: 'Invoice', kind: 'text' },
          { key: 'warrantyEnd', label: 'Warranty ends', kind: 'date' },
          { key: 'daysLeft', label: 'Days left', kind: 'int' },
          { key: 'window', label: 'Window', kind: 'text' },
        ],
        rows: rows.slice(0, ctx.limit).map((r) => ({
          serialNo: r.serialNo,
          productName: r.productName,
          customerName: r.customerName ?? 'Walk-in',
          customerPhone: r.customerPhone,
          invoiceNo: r.invoiceNo,
          warrantyEnd: r.warrantyEnd,
          daysLeft: r.daysLeft,
          window: `Within ${warrantyWindow(r.daysLeft) ?? 90} days`,
          _href: `/serials/${r.unitId}`,
        })),
      },
    ],
  }
}
