'use client'
import SearchSelect, { type SearchOption } from '@/components/ui/SearchSelect'
import { searchReportCustomersAction, searchReportProductsAction, searchReportVendorsAction } from '@/server/actions/reports'
import type { FilterKey } from '@/server/reports/registry'
import { usePathname, useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { Button, Form } from 'react-bootstrap'

type Props = {
  filters: FilterKey[]
  values: { from: string; to: string; group: string; days: string; category: string }
  customer: SearchOption | null
  vendor: SearchOption | null
  product: SearchOption | null
  categories: { value: string; label: string }[]
  csvBase: string
}

/** Filter bar for a report: everything lives in the URL; Apply pushes it. Not shown when printing. */
const ReportFilters = ({ filters, values, customer, vendor, product, categories, csvBase }: Props) => {
  const router = useRouter()
  const pathname = usePathname()
  const [pending, start] = useTransition()
  const [v, setV] = useState(values)
  const [c, setC] = useState(customer)
  const [ve, setVe] = useState(vendor)
  const [p, setP] = useState(product)
  const params = () => {
    const q = new URLSearchParams()
    if (filters.includes('range')) {
      if (v.from) q.set('from', v.from)
      if (v.to) q.set('to', v.to)
    }
    if (filters.includes('group') && v.group !== 'day') q.set('group', v.group)
    if (filters.includes('days') && v.days !== '30') q.set('days', v.days)
    if (filters.includes('category') && v.category) q.set('category', v.category)
    if (filters.includes('customer') && c) q.set('customer', c.value)
    if (filters.includes('vendor') && ve) q.set('vendor', ve.value)
    if (filters.includes('product') && p) q.set('product', p.value)
    return q.toString()
  }
  const apply = () => {
    const qs = params()
    start(() => router.push(qs ? `${pathname}?${qs}` : pathname))
  }
  const csvHref = `${csvBase}${params() ? `?${params()}` : ''}`
  return (
    <Form
      className="d-flex flex-wrap align-items-end gap-2 mb-3 d-print-none"
      style={{ opacity: pending ? 0.6 : 1 }}
      onSubmit={(e) => {
        e.preventDefault()
        apply()
      }}
    >
      {filters.includes('range') && (
        <>
          <div>
            <Form.Label className="small text-muted mb-1" htmlFor="r-from">From</Form.Label>
            <Form.Control size="sm" id="r-from" type="date" value={v.from} max={v.to || undefined} onChange={(e) => setV({ ...v, from: e.target.value })} />
          </div>
          <div>
            <Form.Label className="small text-muted mb-1" htmlFor="r-to">To</Form.Label>
            <Form.Control size="sm" id="r-to" type="date" value={v.to} min={v.from || undefined} onChange={(e) => setV({ ...v, to: e.target.value })} />
          </div>
        </>
      )}
      {filters.includes('group') && (
        <div>
          <Form.Label className="small text-muted mb-1" htmlFor="r-group">Group by</Form.Label>
          <Form.Select size="sm" id="r-group" value={v.group} onChange={(e) => setV({ ...v, group: e.target.value })}>
            <option value="day">Day</option>
            <option value="week">Week (Sat-Fri)</option>
            <option value="month">Month</option>
          </Form.Select>
        </div>
      )}
      {filters.includes('days') && (
        <div>
          <Form.Label className="small text-muted mb-1" htmlFor="r-days">Expiring within</Form.Label>
          <Form.Select size="sm" id="r-days" value={v.days} onChange={(e) => setV({ ...v, days: e.target.value })}>
            <option value="30">30 days</option>
            <option value="60">60 days</option>
            <option value="90">90 days</option>
          </Form.Select>
        </div>
      )}
      {filters.includes('customer') && (
        <div style={{ minWidth: 200 }}>
          <Form.Label className="small text-muted mb-1">Customer</Form.Label>
          <SearchSelect loadOptions={searchReportCustomersAction} value={c} onChange={setC} placeholder="All customers" />
        </div>
      )}
      {filters.includes('vendor') && (
        <div style={{ minWidth: 200 }}>
          <Form.Label className="small text-muted mb-1">Vendor</Form.Label>
          <SearchSelect loadOptions={searchReportVendorsAction} value={ve} onChange={setVe} placeholder="All vendors" />
        </div>
      )}
      {filters.includes('product') && (
        <div style={{ minWidth: 200 }}>
          <Form.Label className="small text-muted mb-1">Product</Form.Label>
          <SearchSelect loadOptions={searchReportProductsAction} value={p} onChange={setP} placeholder="All products" />
        </div>
      )}
      {filters.includes('category') && (
        <div>
          <Form.Label className="small text-muted mb-1" htmlFor="r-cat">Category</Form.Label>
          <Form.Select size="sm" id="r-cat" value={v.category} onChange={(e) => setV({ ...v, category: e.target.value })}>
            <option value="">All categories</option>
            {categories.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Form.Select>
        </div>
      )}
      <Button type="submit" size="sm" disabled={pending}>
        Apply
      </Button>
      <div className="ms-auto d-flex gap-2">
        <a className="btn btn-sm btn-light" href={csvHref}>
          Export CSV
        </a>
        <Button size="sm" variant="light" onClick={() => window.print()}>
          Print
        </Button>
      </div>
    </Form>
  )
}

export default ReportFilters
