'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createProduct, setProductActive, suggestSku, updateProduct } from '../catalog/products'
import { createTaxon, renameTaxon, searchTaxa, setTaxonActive, type TaxonKind } from '../catalog/taxonomy'
import { getDb } from '../db'
import type { SearchOption } from '@/components/ui/SearchSelect'
import { canSeeProfit } from '../lookup/lookup'
import { guarded, type ActionResult } from './guard'

const idSchema = z.uuid()
const PATH: Record<TaxonKind, string> = { category: '/categories', brand: '/brands' }

// ---- products ----
export async function createProductAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return guarded('products.create', async (s) => {
    const row = await createProduct(getDb(), s.cid, s.uid, canSeeProfit(s) ? input : { ...(input as object), purchasePrice: undefined })
    revalidatePath('/products')
    return { id: row.id }
  })
}

export async function updateProductAction(id: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  return guarded('products.edit', async (s) => {
    // Without profit visibility the form has no purchase price: keep the stored one, whatever the client sent.
    const row = await updateProduct(getDb(), s.cid, s.uid, idSchema.parse(id), input, { keepPurchasePrice: !canSeeProfit(s) })
    revalidatePath('/products')
    return { id: row.id }
  })
}

/** Soft delete. */
export async function deactivateProductAction(id: string): Promise<ActionResult> {
  return guarded('products.delete', async (s) => {
    await setProductActive(getDb(), s.cid, s.uid, idSchema.parse(id), false)
    revalidatePath('/products')
  })
}

export async function activateProductAction(id: string): Promise<ActionResult> {
  return guarded('products.edit', async (s) => {
    await setProductActive(getDb(), s.cid, s.uid, idSchema.parse(id), true)
    revalidatePath('/products')
  })
}

export async function suggestSkuAction(name: string): Promise<ActionResult<string>> {
  return guarded('products.create', async (s) => suggestSku(getDb(), s.cid, z.string().max(200).parse(name)))
}

// ---- categories / brands ----
export async function createTaxonAction(kind: TaxonKind, input: unknown): Promise<ActionResult<{ id: string }>> {
  return guarded('products.create', async (s) => {
    const row = await createTaxon(getDb(), s.cid, s.uid, z.enum(['category', 'brand']).parse(kind), input)
    revalidatePath(PATH[kind])
    return { id: row.id }
  })
}

export async function renameTaxonAction(kind: TaxonKind, id: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  return guarded('products.edit', async (s) => {
    const row = await renameTaxon(getDb(), s.cid, s.uid, z.enum(['category', 'brand']).parse(kind), idSchema.parse(id), input)
    revalidatePath(PATH[kind])
    return { id: row.id }
  })
}

export async function setTaxonActiveAction(kind: TaxonKind, id: string, active: boolean): Promise<ActionResult> {
  return guarded(active ? 'products.edit' : 'products.delete', async (s) => {
    await setTaxonActive(getDb(), s.cid, s.uid, z.enum(['category', 'brand']).parse(kind), idSchema.parse(id), z.boolean().parse(active))
    revalidatePath(PATH[kind])
  })
}

// ---- SearchSelect loaders (authorised, company-scoped, max 20) ----
const loader = (kind: TaxonKind) => async (q: string): Promise<SearchOption[]> => {
  const res = await guarded('products.view', (s) => searchTaxa(getDb(), s.cid, kind, String(q ?? '').slice(0, 100)))
  if (!res.ok) throw new Error(res.error)
  return res.data
}
export async function searchCategoriesAction(q: string): Promise<SearchOption[]> {
  return loader('category')(q)
}
export async function searchBrandsAction(q: string): Promise<SearchOption[]> {
  return loader('brand')(q)
}
