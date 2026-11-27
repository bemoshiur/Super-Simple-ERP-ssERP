import Icon from '@/components/wrappers/Icon'
import type { ReactNode } from 'react'
import { Card, CardBody } from 'react-bootstrap'

type Props = {
  icon: string
  label: string
  value: ReactNode
  tone?: 'primary' | 'info' | 'success' | 'warning' | 'danger' | 'secondary'
  hint?: string
}

const KpiCard = ({ icon, label, value, tone = 'primary', hint }: Props) => (
  <Card className="h-100 mb-0">
    <CardBody>
      <div className="d-flex align-items-center gap-3">
        <span className={`icon-tile icon-tile-lg bg-${tone}-subtle text-${tone}`} aria-hidden="true">
          <Icon icon={icon} className="fs-3" />
        </span>
        <div className="min-w-0">
          <p className="text-muted mb-1 text-truncate">{label}</p>
          <h4 className="mb-0 fw-bold" style={{ overflowWrap: 'anywhere' }}>
            {value}
          </h4>
          {hint && <small className="text-muted">{hint}</small>}
        </div>
      </div>
    </CardBody>
  </Card>
)

export default KpiCard
