'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import type { SessionPayload } from '../auth/session'
import { writeCtx } from '../branch'
import { getDb } from '../db'
import { FieldErrors } from '../errors'
import { searchParties } from '../parties/parties'
import { can } from '../rbac'
import {
  PROFIT_PERMISSIONS,
  collectCustomerDue,
  createSale,
  createSaleReturn,
  lookupSerialForSale,
  recordCustomerPayment,
  searchProductsForSale,
  type SaleProductOption,
  type SerialLookup,
} from '../sales/sales'
import { guarded, guardedBranch, type ActionResult } from './guard'

const idSchema = z.uuid()
const seesProfit = (s: SessionPayload) => PROFIT_PERMISSIONS.some((k) => can(s, k))

/** Create a sale invoice (sales.create). Resubmitting the same idempotencyKey returns the existing invoice. */
export async function createSaleAction(input: unknown): Promise<ActionResult<{ id: string; invoiceNo: string; duplicate: boolean }>> {
  return guardedBranch('sales.create', async (s, b) => {
    const r = await createSale(getDb(), s.cid, s.uid, input, writeCtx(b))
    revalidatePath('/sales')
    revalidatePath('/customers')
    return { id: r.id, invoiceNo: r.invoiceNo, duplicate: r.duplicate }
  })
}

/** POS scan: the in-stock unit for a serial (cost only for roles that may see profit). */
export async function lookupSaleSerialAction(serial: string): Promise<ActionResult<SerialLookup>> {
  return guardedBranch('sales.create', async (s, b) => {
    const r = await lookupSerialForSale(getDb(), s.cid, b.active, String(serial ?? '').slice(0, 256), { withCost: seesProfit(s) })
    if (!r.ok) throw new FieldErrors({ serial: r.error }, r.error) // expected outcome: shown on the scan box
    return r.unit
  })
}

/** Non-serial product picker for the POS (sales.create). */
export async function searchSaleProductsAction(q: string): Promise<SaleProductOption[]> {
  const res = await guardedBranch('sales.create', (s, b) => searchProductsForSale(getDb(), s.cid, b.active ?? b.home, String(q ?? '').slice(0, 100), { withCost: seesProfit(s) }))
  if (!res.ok) throw new Error(res.error)
  return res.data
}

/** Customer picker for the POS and the sales list filter: sales.view is enough. */
export async function searchSaleCustomersAction(q: string) {
  const res = await guarded('sales.view', (s) => searchParties(getDb(), s.cid, 'customer', String(q ?? '').slice(0, 100)))
  if (!res.ok) throw new Error(res.error)
  return res.data
}

/** Collect against one invoice's due (sales.edit). */
export async function recordCustomerPaymentAction(saleId: string, input: unknown): Promise<ActionResult<{ due: string }>> {
  return guardedBranch('sales.edit', async (s, b) => {
    const id = idSchema.parse(saleId)
    const r = await recordCustomerPayment(getDb(), s.cid, s.uid, id, input, writeCtx(b))
    revalidatePath('/sales')
    revalidatePath(`/sales/${id}`)
    return { due: r.due }
  })
}

/** Customer-level collection applied to the oldest unpaid invoices first (sales.edit). */
export async function collectCustomerDueAction(customerId: string, input: unknown): Promise<ActionResult<{ allocations: { saleId: string; invoiceNo: string; amount: string; due: string }[]; remainingDue: string }>> {
  return guardedBranch('sales.edit', async (s, b) => {
    const id = idSchema.parse(customerId)
    const r = await collectCustomerDue(getDb(), s.cid, s.uid, id, input, writeCtx(b))
    revalidatePath('/sales')
    revalidatePath(`/customers/${id}`)
    return r
  })
}

/** Return lines/units of an invoice, refunding any credit beyond the due (sales.edit). */
export async function createSaleReturnAction(saleId: string, input: unknown): Promise<ActionResult<{ returnNo: string; credit: string; refund: string }>> {
  return guardedBranch('sales.edit', async (s, b) => {
    const id = idSchema.parse(saleId)
    const r = await createSaleReturn(getDb(), s.cid, s.uid, id, input, writeCtx(b))
    revalidatePath('/sales')
    revalidatePath('/sales/returns')
    revalidatePath(`/sales/${id}`)
    return { returnNo: r.returnNo, credit: r.credit, refund: r.refund }
  })
}
