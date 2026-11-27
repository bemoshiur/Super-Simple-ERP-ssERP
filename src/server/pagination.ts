/**
 * URL-driven list state: `?q=<search>&page=<n>`. Pure helpers shared by server pages (parse + query)
 * and the PaginatedTable client component (build links). No DB access here.
 *
 * Typical server page:
 *   const { q, page, pageSize, offset } = parseListParams(await searchParams)
 *   const where = and(eq(t.companyId, session.cid), q ? ilike(t.name, likePattern(q)) : undefined)
 *   const [rows, [{ n }]] = await Promise.all([db.select()...where(where).limit(pageSize).offset(offset), db.select({ n: count() })...where(where)])
 *   <PaginatedTable rows={rows} total={n} page={page} pageSize={pageSize} q={q} columns={...} />
 */
export const DEFAULT_PAGE_SIZE = 20
export const MAX_PAGE_SIZE = 100
export const MAX_QUERY_LENGTH = 100
const MAX_PAGE = 1_000_000

export type RawSearchParams = Record<string, string | string[] | undefined>
export type ListParams = { q: string; page: number; pageSize: number; offset: number }

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

/** Parse `?q=&page=` defensively: untrusted input never throws and is always clamped. */
export function parseListParams(sp: RawSearchParams | undefined, opts: { pageSize?: number } = {}): ListParams {
  const pageSize = Math.min(Math.max(Math.trunc(opts.pageSize ?? DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE)
  const q = (first(sp?.q) ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_LENGTH)
  const raw = first(sp?.page) ?? ''
  const n = /^\d{1,7}$/.test(raw) ? Number(raw) : 1
  const page = Math.min(Math.max(n, 1), MAX_PAGE)
  return { q, page, pageSize, offset: (page - 1) * pageSize }
}

/** ILIKE pattern for a user search term with LIKE wildcards escaped: "50%_off" matches literally. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

export type PageMeta = { page: number; pageCount: number; total: number; start: number; end: number; hasPrev: boolean; hasNext: boolean }

/** Derive display metadata; clamps `page` into range (e.g. a stale ?page=9 after the list shrank). */
export function pageMeta(total: number, page: number, pageSize: number): PageMeta {
  const safeTotal = Math.max(0, Math.trunc(total) || 0)
  const pageCount = Math.max(1, Math.ceil(safeTotal / pageSize))
  const p = Math.min(Math.max(page, 1), pageCount)
  const start = safeTotal === 0 ? 0 : (p - 1) * pageSize + 1
  const end = Math.min(p * pageSize, safeTotal)
  return { page: p, pageCount, total: safeTotal, start, end, hasPrev: p > 1, hasNext: p < pageCount }
}

/** Build `<path>?...` keeping unrelated params, setting q/page; page 1 and empty q are omitted. */
export function listHref(path: string, current: URLSearchParams | RawSearchParams, patch: { q?: string; page?: number }): string {
  const params = new URLSearchParams()
  const entries = current instanceof URLSearchParams ? [...current.entries()] : Object.entries(current).flatMap(([k, v]) => (v === undefined ? [] : Array.isArray(v) ? v.map((x) => [k, x] as [string, string]) : [[k, v] as [string, string]]))
  for (const [k, v] of entries) if (k !== 'q' && k !== 'page') params.append(k, v)
  const q = patch.q ?? (current instanceof URLSearchParams ? current.get('q') : first(current.q)) ?? ''
  if (q) params.set('q', q)
  // Changing the search always returns to page 1.
  const page = patch.q !== undefined ? 1 : (patch.page ?? 1)
  if (page > 1) params.set('page', String(page))
  const qs = params.toString()
  return qs ? `${path}?${qs}` : path
}

/** Page numbers to render with `null` gaps for ellipses, e.g. [1, null, 4, 5, 6, null, 20]. */
export function pageWindow(page: number, pageCount: number, span = 1): Array<number | null> {
  const pages = new Set<number>([1, pageCount])
  for (let i = page - span; i <= page + span; i++) if (i >= 1 && i <= pageCount) pages.add(i)
  const sorted = [...pages].sort((a, b) => a - b)
  const out: Array<number | null> = []
  sorted.forEach((n, i) => {
    if (i > 0 && n - sorted[i - 1] > 1) out.push(null)
    out.push(n)
  })
  return out
}
