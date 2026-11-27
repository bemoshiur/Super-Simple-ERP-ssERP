'use server'

import { getDb } from '../db'
import { searchParties } from '../parties/parties'
import { searchProductsForReport } from '../reports/lookups'
import { guarded } from './guard'

/** Pickers for the report filter bar: reports.view is enough (the viewer may not hold customers/vendors/products.view). */
export async function searchReportCustomersAction(q: string) {
  const res = await guarded('reports.view', (s) => searchParties(getDb(), s.cid, 'customer', String(q ?? '').slice(0, 100)))
  if (!res.ok) throw new Error(res.error)
  return res.data
}

export async function searchReportVendorsAction(q: string) {
  const res = await guarded('reports.view', (s) => searchParties(getDb(), s.cid, 'vendor', String(q ?? '').slice(0, 100)))
  if (!res.ok) throw new Error(res.error)
  return res.data
}

export async function searchReportProductsAction(q: string) {
  const res = await guarded('reports.view', (s) => searchProductsForReport(getDb(), s.cid, String(q ?? '')))
  if (!res.ok) throw new Error(res.error)
  return res.data
}
