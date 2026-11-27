'use client'
import { usePathname, useRouter } from 'next/navigation'
import { useState, useTransition, type ReactNode } from 'react'
import { Button, Form } from 'react-bootstrap'

export type FilterField = { name: string; label: string; type: 'date' | 'text' | 'select'; options?: { value: string; label: string }[]; placeholder?: string; width?: number }

/**
 * Generic GET filter bar: edits are local until "Apply", which pushes `?name=value` params (empty ones omitted, paging reset).
 * `hidden` params (e.g. ?tab=) are always kept. `extra` renders to the right (e.g. an export button). Hidden when printing.
 */
const FilterBar = ({ fields, values, extra, resetHref, hidden }: { fields: FilterField[]; values: Record<string, string>; extra?: ReactNode; resetHref?: string; hidden?: Record<string, string> }) => {
  const router = useRouter()
  const pathname = usePathname()
  const [pending, start] = useTransition()
  const [v, setV] = useState(values)
  const apply = () => {
    const p = new URLSearchParams()
    for (const [k, val] of Object.entries(hidden ?? {})) if (val) p.set(k, val)
    for (const f of fields) if (v[f.name]) p.set(f.name, v[f.name])
    const qs = p.toString()
    start(() => router.push(qs ? `${pathname}?${qs}` : pathname))
  }
  return (
    <Form
      className="d-flex flex-wrap align-items-end gap-2 mb-3 d-print-none"
      onSubmit={(e) => {
        e.preventDefault()
        apply()
      }}
      style={{ opacity: pending ? 0.6 : 1 }}
    >
      {fields.map((f) => (
        <div key={f.name} style={{ width: f.width }}>
          <Form.Label className="small text-muted mb-1" htmlFor={`f-${f.name}`}>
            {f.label}
          </Form.Label>
          {f.type === 'select' ? (
            <Form.Select size="sm" id={`f-${f.name}`} value={v[f.name] ?? ''} onChange={(e) => setV((s) => ({ ...s, [f.name]: e.target.value }))}>
              {(f.options ?? []).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Form.Select>
          ) : (
            <Form.Control size="sm" id={`f-${f.name}`} type={f.type} placeholder={f.placeholder} maxLength={50} value={v[f.name] ?? ''} onChange={(e) => setV((s) => ({ ...s, [f.name]: e.target.value }))} />
          )}
        </div>
      ))}
      <Button type="submit" size="sm" disabled={pending}>
        Apply
      </Button>
      <Button size="sm" variant="light" onClick={() => start(() => router.push(resetHref ?? pathname))} disabled={pending}>
        Reset
      </Button>
      {extra && <div className="ms-auto d-flex gap-2">{extra}</div>}
    </Form>
  )
}

export default FilterBar
