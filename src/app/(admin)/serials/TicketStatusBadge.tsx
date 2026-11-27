import { Badge } from 'react-bootstrap'

const TONE: Record<string, string> = { open: 'warning', in_progress: 'info', resolved: 'success', closed: 'secondary', rejected: 'danger' }
const LABEL: Record<string, string> = { open: 'Open', in_progress: 'In progress', resolved: 'Resolved', closed: 'Closed', rejected: 'Rejected' }

const TicketStatusBadge = ({ status, underWarranty }: { status: string; underWarranty?: boolean }) => (
  <>
    <Badge bg={`${TONE[status] ?? 'secondary'}-subtle`} text={TONE[status] ?? 'secondary'}>
      {LABEL[status] ?? status}
    </Badge>
    {underWarranty !== undefined && (
      <Badge bg={underWarranty ? 'success-subtle' : 'secondary-subtle'} text={underWarranty ? 'success' : 'secondary'} className="ms-1">
        {underWarranty ? 'In warranty' : 'Out of warranty'}
      </Badge>
    )}
  </>
)

export default TicketStatusBadge
