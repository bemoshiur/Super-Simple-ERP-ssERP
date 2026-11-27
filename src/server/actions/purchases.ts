'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { writeCtx } from '../branch'
import { getDb } from '../db'
import { searchParties } from '../parties/parties'
import { createPurchase, createPurchaseReturn, recordVendorPayment, searchProductsForPurchase, type PurchaseProductOption } from '../purchases/purchases'
import { guarded, guardedBranch, type ActionResult } from './guard'

const idSchema = z.uuid()

/** Create a received purchase invoice (serial intake + stock + optional payment). */
export async function createPurchaseAction(input: unknown): Promise<ActionResult<{ id: string; invoiceNo: string }>> {
  return guardedBranch('purchases.create', async (s, b) => {
    const r = await createPurchase(getDb(), s.cid, s.uid, input, writeCtx(b))
    revalidatePath('/purchases')
    revalidatePath('/vendors')
    return { id: r.id, invoiceNo: r.invoiceNo }
  })
}

/** Pay against one invoice's due (purchases.edit). */
export async function recordVendorPaymentAction(purchaseId: string, input: unknown): Promise<ActionResult<{ due: string }>> {
  return guardedBranch('purchases.edit', async (s, b) => {
    const id = idSchema.parse(purchaseId)
    const r = await recordVendorPayment(getDb(), s.cid, s.uid, id, input, writeCtx(b))
    revalidatePath('/purchases')
    revalidatePath(`/purchases/${id}`)
    return { due: r.due }
  })
}

/** Return selected in-stock units of an invoice to the vendor (purchases.edit). */
export async function createPurchaseReturnAction(purchaseId: string, input: unknown): Promise<ActionResult<{ returnNo: string }>> {
  return guardedBranch('purchases.edit', async (s, b) => {
    const id = idSchema.parse(purchaseId)
    const r = await createPurchaseReturn(getDb(), s.cid, s.uid, id, input, writeCtx(b))
    revalidatePath('/purchases')
    revalidatePath(`/purchases/${id}`)
    return { returnNo: r.returnNo }
  })
}

/** Product picker for the purchase form: needs purchases.create (not products.view). */
export async function searchPurchaseProductsAction(q: string): Promise<PurchaseProductOption[]> {
  const res = await guarded('purchases.create', (s) => searchProductsForPurchase(getDb(), s.cid, String(q ?? '').slice(0, 100)))
  if (!res.ok) throw new Error(res.error)
  return res.data
}

/** Vendor picker for purchase forms/filters: purchases.view is enough. */
export async function searchPurchaseVendorsAction(q: string) {
  const res = await guarded('purchases.view', (s) => searchParties(getDb(), s.cid, 'vendor', String(q ?? '').slice(0, 100)))
  if (!res.ok) throw new Error(res.error)
  return res.data
}
