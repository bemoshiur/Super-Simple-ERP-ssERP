import { STATUS_LABEL, type UnitStatus } from '@/server/serials'
import Link from 'next/link'
import { Badge } from 'react-bootstrap'

export const UNIT_TONE: Record<UnitStatus, string> = { in_stock: 'success', sold: 'primary', returned_to_vendor: 'secondary', in_service: 'info', damaged: 'danger' }

/** A serial number coloured by unit status (status spelled out unless in stock). With `unitId` it links to the serial history page. */
const UnitChip = ({ serial, status, unitId }: { serial: string; status: UnitStatus; unitId?: string | null }) => {
  const chip = (
    <Badge bg={`${UNIT_TONE[status]}-subtle`} text={UNIT_TONE[status]} className="font-monospace fw-normal me-1 mb-1" title={unitId ? `${STATUS_LABEL[status]}: open serial history` : STATUS_LABEL[status]}>
      {serial}
      {status !== 'in_stock' && <span className="ms-1">· {STATUS_LABEL[status]}</span>}
    </Badge>
  )
  return unitId ? (
    <Link href={`/serials/${unitId}`} className="text-decoration-none">
      {chip}
    </Link>
  ) : (
    chip
  )
}

export default UnitChip
