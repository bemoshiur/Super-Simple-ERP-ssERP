import { and, eq, sql } from 'drizzle-orm'
import { rowsOf, schema, type Db } from './db'
import type { DocKind } from './db/schema/core'

/** settings key holding the prefix for each document kind, and the fallback when the setting is missing. */
export const DOC_PREFIX: Readonly<Record<DocKind, { key: string; fallback: string }>> = {
  sale: { key: 'invoice_prefix_sale', fallback: 'INV-' },
  purchase: { key: 'invoice_prefix_purchase', fallback: 'PUR-' },
  sale_return: { key: 'invoice_prefix_sale_return', fallback: 'SR-' },
  purchase_return: { key: 'invoice_prefix_purchase_return', fallback: 'PR-' },
  service: { key: 'invoice_prefix_service', fallback: 'SVC-' },
  transfer: { key: 'invoice_prefix_transfer', fallback: 'TRF-' },
}

/** "PUR-" + 7 -> "PUR-00007" (grows past 5 digits naturally). Pure. */
export function formatDocNumber(prefix: string, n: number): string {
  return `${prefix}${String(n).padStart(5, '0')}`
}

/**
 * Allocate the next document number for (company, kind) INSIDE the caller's transaction.
 * The upsert row-locks the counter until commit, so concurrent transactions are serialised and can never get
 * the same number; a rolled-back transaction gives its number back. Prefix comes from company settings.
 */
export async function nextDocNumber(tx: Pick<Db, 'execute' | 'select'>, companyId: string, kind: DocKind): Promise<string> {
  const res = await tx.execute(sql`
    insert into ${schema.docSequences} (company_id, kind, next_value) values (${companyId}, ${kind}, 2)
    on conflict (company_id, kind) do update set next_value = ${schema.docSequences}.next_value + 1
    returning next_value - 1 as n`)
  const n = Number(rowsOf<{ n: number | string }>(res)[0]?.n)
  if (!Number.isSafeInteger(n) || n < 1) throw new Error('Could not allocate a document number')
  const { key, fallback } = DOC_PREFIX[kind]
  const [s] = await tx
    .select({ v: schema.settings.value })
    .from(schema.settings)
    .where(and(eq(schema.settings.companyId, companyId), eq(schema.settings.key, key)))
  const prefix = (s?.v ?? fallback).trim().slice(0, 20)
  return formatDocNumber(prefix, n)
}
