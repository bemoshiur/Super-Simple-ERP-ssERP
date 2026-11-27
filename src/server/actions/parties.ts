'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import type { SearchOption } from '@/components/ui/SearchSelect'
import { getDb } from '../db'
import { createParty, searchParties, setPartyActive, updateParty, type PartyKind } from '../parties/parties'
import type { Permission } from '../rbac'
import { guarded, type ActionResult } from './guard'

const idSchema = z.uuid()
const BAD_KIND = { ok: false as const, error: 'Unknown party type.' }
/** Safe lookup, no throwing: an unknown kind yields null before anything else runs. */
const modOf = (k: unknown) => (k === 'vendor' ? 'vendors' : k === 'customer' ? 'customers' : null)
const mod = (k: PartyKind) => modOf(k) as 'vendors' | 'customers'
const path = (k: PartyKind) => `/${mod(k)}`
const perm = (k: PartyKind, a: 'view' | 'create' | 'edit' | 'delete') => `${mod(k)}.${a}` as Permission

export async function createPartyAction(kind: PartyKind, input: unknown): Promise<ActionResult<{ id: string }>> {
  if (!modOf(kind)) return BAD_KIND
  const k = kind
  return guarded(perm(k, 'create'), async (s) => {
    const row = await createParty(getDb(), s.cid, s.uid, k, input)
    revalidatePath(path(k))
    return { id: row.id }
  })
}

export async function updatePartyAction(kind: PartyKind, id: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  if (!modOf(kind)) return BAD_KIND
  const k = kind
  return guarded(perm(k, 'edit'), async (s) => {
    const row = await updateParty(getDb(), s.cid, s.uid, k, idSchema.parse(id), input)
    revalidatePath(path(k))
    revalidatePath(`${path(k)}/${row.id}`)
    return { id: row.id }
  })
}

/** Soft delete (active=false). */
export async function deactivatePartyAction(kind: PartyKind, id: string): Promise<ActionResult> {
  if (!modOf(kind)) return BAD_KIND
  const k = kind
  return guarded(perm(k, 'delete'), async (s) => {
    await setPartyActive(getDb(), s.cid, s.uid, k, idSchema.parse(id), false)
    revalidatePath(path(k))
  })
}

export async function activatePartyAction(kind: PartyKind, id: string): Promise<ActionResult> {
  if (!modOf(kind)) return BAD_KIND
  const k = kind
  return guarded(perm(k, 'edit'), async (s) => {
    await setPartyActive(getDb(), s.cid, s.uid, k, idSchema.parse(id), true)
    revalidatePath(path(k))
  })
}

// ---- SearchSelect loaders (authorised, company-scoped, max 20) ----
async function load(kind: PartyKind, q: string): Promise<SearchOption[]> {
  if (!modOf(kind)) throw new Error('Unknown party type.')
  const res = await guarded(perm(kind, 'view'), (s) => searchParties(getDb(), s.cid, kind, String(q ?? '').slice(0, 100)))
  if (!res.ok) throw new Error(res.error)
  return res.data
}
export async function searchVendorsAction(q: string): Promise<SearchOption[]> {
  return load('vendor', q)
}
export async function searchCustomersAction(q: string): Promise<SearchOption[]> {
  return load('customer', q)
}
