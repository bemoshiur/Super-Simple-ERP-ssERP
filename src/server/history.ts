import { schema, type Db } from './db'

export type FieldDiff = Record<string, { from: unknown; to: unknown }>

/** Changed fields among `keys` (strict inequality after null-normalising undefined/''). */
export function diffFields(before: Record<string, unknown>, after: Record<string, unknown>, keys: readonly string[]): FieldDiff {
  const norm = (v: unknown) => (v === undefined || v === '' ? null : v)
  const out: FieldDiff = {}
  for (const k of keys) {
    const a = norm(before[k])
    const b = norm(after[k])
    if (a !== b) out[k] = { from: a, to: b }
  }
  return out
}

/** Append a record_history row when something tracked changed. Call inside the caller's transaction. */
export async function writeHistory(tx: Pick<Db, 'insert'>, p: { companyId: string; userId: string; entity: string; entityId: string; diff: FieldDiff }) {
  if (Object.keys(p.diff).length === 0) return
  await tx.insert(schema.recordHistory).values({ companyId: p.companyId, entity: p.entity, entityId: p.entityId, changedBy: p.userId, diff: p.diff })
}
