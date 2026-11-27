'use client'
import SearchSelect, { type SearchOption } from '@/components/ui/SearchSelect'
import { searchBrandsAction, searchCategoriesAction } from '@/server/actions/catalog'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useState, useTransition } from 'react'
import { Button, Form } from 'react-bootstrap'

/** /stock filters, all in the URL: ?q=&category=&brand=&low=1&type=serial|plain (paging resets on change). */
const StockFilters = ({ q, category, brand, low, type }: { q: string; category: SearchOption | null; brand: SearchOption | null; low: boolean; type: string }) => {
  const router = useRouter()
  const pathname = usePathname()
  const sp = useSearchParams()
  const [pending, start] = useTransition()
  const [text, setText] = useState(q)
  const push = (patch: Record<string, string | null>) => {
    const params = new URLSearchParams(sp.toString())
    params.delete('page')
    for (const [k, v] of Object.entries(patch)) {
      if (v) params.set(k, v)
      else params.delete(k)
    }
    const qs = params.toString()
    start(() => router.push(qs ? `${pathname}?${qs}` : pathname))
  }
  return (
    <div className="d-flex flex-wrap gap-2 align-items-center mb-3 d-print-none" style={{ opacity: pending ? 0.6 : 1 }}>
      <Form
        className="d-flex gap-1"
        onSubmit={(e) => {
          e.preventDefault()
          push({ q: text.trim() || null })
        }}
      >
        <Form.Control size="sm" placeholder="Search name or SKU…" maxLength={100} value={text} onChange={(e) => setText(e.target.value)} aria-label="Search products" style={{ width: 220 }} />
        <Button size="sm" type="submit" variant="tonal-secondary" aria-label="Search">
          Search
        </Button>
      </Form>
      <div style={{ minWidth: 200 }}>
        <SearchSelect loadOptions={searchCategoriesAction} value={category} onChange={(o) => push({ category: o?.value ?? null })} placeholder="All categories" />
      </div>
      <div style={{ minWidth: 200 }}>
        <SearchSelect loadOptions={searchBrandsAction} value={brand} onChange={(o) => push({ brand: o?.value ?? null })} placeholder="All brands" />
      </div>
      <Form.Select size="sm" style={{ width: 170 }} value={type} onChange={(e) => push({ type: e.target.value || null })} aria-label="Tracking">
        <option value="">Serial and quantity</option>
        <option value="serial">Serial-tracked only</option>
        <option value="plain">Quantity only</option>
      </Form.Select>
      <Form.Check type="switch" id="low-only" label="Low stock only" checked={low} onChange={(e) => push({ low: e.target.checked ? '1' : null })} />
      {(q || category || brand || low || type) && (
        <Button size="sm" variant="light" onClick={() => start(() => router.push(pathname))}>
          Reset
        </Button>
      )}
    </div>
  )
}

export default StockFilters
