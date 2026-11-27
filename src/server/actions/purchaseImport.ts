'use server'

import { revalidatePath } from 'next/cache'
import { writeCtx } from '../branch'
import { getDb } from '../db'
import { importSerialPurchase, previewSerialImport, type ImportPreview, type ImportedPurchase } from '../purchases/import'
import { importInputFromFormData } from '../purchases/importForm'
import { guarded, guardedBranch, type ActionResult } from './guard'

/** Dry run of a serial import CSV: validates every row, writes nothing (purchases.create). */
export async function previewPurchaseImportAction(formData: FormData): Promise<ActionResult<ImportPreview>> {
  return guarded('purchases.create', async (s) => previewSerialImport(getDb(), s.cid, await importInputFromFormData(formData)))
}

/** Import the CSV as ONE purchase in ONE transaction; any bad row rejects the whole file (purchases.create). */
export async function importPurchaseAction(formData: FormData): Promise<ActionResult<ImportedPurchase>> {
  return guardedBranch('purchases.create', async (s, b) => {
    const r = await importSerialPurchase(getDb(), s.cid, s.uid, await importInputFromFormData(formData), writeCtx(b))
    revalidatePath('/purchases')
    revalidatePath('/vendors')
    revalidatePath('/serials', 'layout')
    revalidatePath('/stock')
    return r
  })
}
