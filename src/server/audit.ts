import { getDb, schema, type Db } from './db'

export type ActivityInput = {
  companyId: string
  userId?: string | null
  action: string
  entity: string
  entityId?: string | null
  before?: unknown
  after?: unknown
  ip?: string | null
}

/** Keys whose values must never reach activity_log (defence in depth: callers should not pass them anyway). */
export const SECRET_KEY_RE = /hash|passw|secret|token|otp|api[_-]?key|authori[sz]ation|cookie|credential/i
/** Short words that are secrets only as a whole word of the key (`pin`, `pinCode`, `user_pin`; not `shipping`, `sessionsRevoked`). */
const SECRET_WORDS = new Set(['pin', 'session', 'pwd'])
const words = (k: string) => k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/)
export const isSecretKey = (k: string) => SECRET_KEY_RE.test(k) || words(k).some((w) => SECRET_WORDS.has(w))

const isPlainObject = (v: object) => {
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/**
 * JSON-safe deep copy of `value` with every secret-looking key dropped. Cycles become '[Circular]' (a value referenced twice
 * on different branches is copied twice, not flagged); non-plain objects become a typed placeholder (Date -> ISO string,
 * Buffer/typed arrays -> '[binary N bytes]', Map/Set -> '[Map]'/'[Set]', other class instances -> '[ClassName]').
 */
export function redactSecrets(value: unknown, path: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || typeof value !== 'object') return typeof value === 'bigint' ? value.toString() : typeof value === 'function' || typeof value === 'symbol' ? undefined : value
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return `[binary ${value.byteLength} bytes]`
  if (value instanceof Map) return '[Map]'
  if (value instanceof Set) return '[Set]'
  if (!Array.isArray(value) && !isPlainObject(value)) return `[${value.constructor?.name ?? 'Object'}]`
  if (path.has(value)) return '[Circular]'
  path.add(value)
  try {
    if (Array.isArray(value)) return value.map((v) => redactSecrets(v, path))
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretKey(k)) continue
      const r = redactSecrets(v, path)
      if (r !== undefined) out[k] = r
    }
    return out
  } finally {
    path.delete(value)
  }
}

/** Append an activity_log row. Pass `tx` to log inside the caller's transaction. Secret-looking keys are dropped. */
export async function logActivity(input: ActivityInput, tx?: Pick<Db, 'insert'>) {
  const db = tx ?? getDb()
  await db.insert(schema.activityLog).values({
    companyId: input.companyId,
    userId: input.userId ?? null,
    action: input.action,
    entity: input.entity,
    entityId: input.entityId ?? null,
    before: input.before == null ? null : redactSecrets(input.before),
    after: input.after == null ? null : redactSecrets(input.after),
    ip: input.ip ?? null,
  })
}
