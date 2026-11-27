'use server'

import { revalidatePath } from 'next/cache'
import { requireWriteBranch, writeCtx } from '../branch'
import { getDb } from '../db'
import { adjustStock, applyStockCount, type AdjustmentResult, type ApplyCountResult } from '../inventory/adjustments'
import { computeCountDiff, loadCountSheet, type CountDiff, type CountSheetRow } from '../inventory/count'
import { createStockTransfer } from '../inventory/transfers'
import { searchProductsForSale } from '../sales/sales'
import { z } from 'zod'
import { guardedBranch, type ActionResult } from './guard'

/** Stock adjustment (non-serial +/- qty, or a serial unit marked damaged/lost). products.edit. */
export async function adjustStockAction(input: unknown): Promise<ActionResult<AdjustmentResult>> {
  return guardedBranch('products.edit', async (s, b) => {
    const r = await adjustStock(getDb(), s.cid, s.uid, input, writeCtx(b))
    revalidatePath('/stock')
    revalidatePath(`/products/${r.productId}`)
    return r
  })
}

/** Stock-take: load the products to count (no costs) in the ACTIVE branch (a count is physical: one branch). products.edit. */
export async function loadCountSheetAction(input: unknown): Promise<ActionResult<{ rows: CountSheetRow[]; truncated: boolean }>> {
  return guardedBranch('products.edit', (s, b) => loadCountSheet(getDb(), s.cid, requireWriteBranch(b), input))
}

/** Stock-take: counted vs system diff in the ACTIVE branch (report only; nothing is written). products.edit. */
export async function countDiffAction(input: unknown): Promise<ActionResult<CountDiff>> {
  return guardedBranch('products.edit', (s, b) => computeCountDiff(getDb(), s.cid, requireWriteBranch(b), input))
}

/** Stock-take: apply non-serial count corrections in one transaction. products.edit. */
export async function applyCountAction(input: unknown): Promise<ActionResult<ApplyCountResult>> {
  return guardedBranch('products.edit', async (s, b) => {
    const r = await applyStockCount(getDb(), s.cid, s.uid, input, writeCtx(b))
    revalidatePath('/stock')
    return r
  })
}

/** Inter-branch transfer (products.edit; a user without branches.all can only send stock out of its own branch). */
export async function createTransferAction(input: unknown): Promise<ActionResult<{ id: string; transferNo: string; duplicate: boolean }>> {
  return guardedBranch('products.edit', async (s, b) => {
    const r = await createStockTransfer(getDb(), s.cid, s.uid, input, { restrict: b.restrict })
    revalidatePath('/stock', 'layout')
    revalidatePath('/products', 'layout')
    return { id: r.id, transferNo: r.transferNo, duplicate: r.duplicate }
  })
}

/** Quantity-product picker for the transfer form: on-hand at the SOURCE branch (must be one the user may transfer from). */
export async function searchTransferProductsAction(q: string, fromBranchId: string): Promise<{ value: string; label: string; description: string; onHand: number }[]> {
  const res = await guardedBranch('products.edit', async (s, b) => {
    const from = z.uuid().parse(fromBranchId)
    // A restricted user can only send from (and so only sees quantities of) its own branch.
    if (!b.branches.some((x) => x.id === from) || (b.restrict && from !== b.restrict)) return []
    const rows = await searchProductsForSale(getDb(), s.cid, from, String(q ?? '').slice(0, 100))
    return rows.map((r) => ({ value: r.value, label: r.label, description: r.description ?? '', onHand: r.onHand }))
  })
  if (!res.ok) throw new Error(res.error)
  return res.data
}
