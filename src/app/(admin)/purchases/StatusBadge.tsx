import { displayStatus } from '@/server/purchases/totals'
import { Badge } from 'react-bootstrap'

const MAP = {
  unpaid: { bg: 'warning-subtle', text: 'warning', label: 'Unpaid' },
  partially_paid: { bg: 'info-subtle', text: 'info', label: 'Partially paid' },
  paid: { bg: 'success-subtle', text: 'success', label: 'Paid' },
  returned: { bg: 'secondary-subtle', text: 'secondary', label: 'Returned' },
} as const

export const STATUS_OPTIONS = [
  { value: 'unpaid', label: 'Unpaid' },
  { value: 'partially_paid', label: 'Partially paid' },
  { value: 'paid', label: 'Paid' },
  { value: 'returned', label: 'Fully returned' },
] as const

type Amounts = { total: string; returnedTotal: string; paid: string; due: string }

/** Display status derived from the amounts (displayStatus), plus a "Part returned" marker. The stored enum is not shown. */
const PurchaseStatusBadge = ({ p }: { p: Amounts }) => {
  const st = displayStatus(p)
  const m = MAP[st]
  return (
    <span className="d-inline-flex gap-1 flex-wrap">
      <Badge bg={m.bg} text={m.text}>
        {m.label}
      </Badge>
      {st !== 'returned' && p.returnedTotal !== '0.00' && (
        <Badge bg="secondary-subtle" text="secondary">
          Part returned
        </Badge>
      )}
    </span>
  )
}

export default PurchaseStatusBadge
