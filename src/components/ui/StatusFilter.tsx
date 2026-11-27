'use client'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTransition } from 'react'
import { Form } from 'react-bootstrap'

export type StatusValue = 'active' | 'inactive' | 'all'

/** Active/inactive/all selector kept in the URL (`?status=`); active is the default and omitted. Resets paging. */
const StatusFilter = ({ value }: { value: StatusValue }) => {
  const router = useRouter()
  const pathname = usePathname()
  const sp = useSearchParams()
  const [pending, start] = useTransition()
  return (
    <Form.Select
      size="sm"
      style={{ width: 'auto' }}
      aria-label="Filter by status"
      value={value}
      disabled={pending}
      onChange={(e) => {
        const params = new URLSearchParams(sp.toString())
        params.delete('page')
        if (e.target.value === 'active') params.delete('status')
        else params.set('status', e.target.value)
        const qs = params.toString()
        start(() => router.push(qs ? `${pathname}?${qs}` : pathname))
      }}
    >
      <option value="active">Active</option>
      <option value="inactive">Inactive</option>
      <option value="all">All</option>
    </Form.Select>
  )
}

export default StatusFilter
