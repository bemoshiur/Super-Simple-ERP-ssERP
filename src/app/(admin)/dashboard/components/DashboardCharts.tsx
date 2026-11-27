'use client'
import EmptyState from '@/components/ui/EmptyState'
import ChartJs, { cssToken } from '@/components/wrappers/ChartJs'
import { fmtBD } from '@/server/money'
import type { SalesPoint, TopProduct } from '@/server/dashboard'
import { BarController, BarElement, Filler, LineController, LineElement, PointElement } from 'chart.js'
import { useCallback } from 'react'
import { Card, CardBody, CardHeader, Col, Row } from 'react-bootstrap'

const shortDay = (iso: string) => {
  const [, m, d] = iso.split('-')
  return `${d}/${m}`
}

/** Chart axes are display-only; values come from SQL numeric strings and are never summed here. */
const num = (v: string) => Number(v)

const DashboardCharts = ({ last7, top }: { last7: SalesPoint[]; top: TopProduct[] }) => {
  const hasSales = last7.some((p) => num(p.total) > 0)

  const salesOptions = useCallback(
    () => ({
      data: {
        labels: last7.map((p) => shortDay(p.day)),
        datasets: [
          {
            label: 'Sales',
            data: last7.map((p) => num(p.total)),
            borderColor: cssToken('--ss-brand'),
            backgroundColor: cssToken('--ss-brand', 0.14),
            fill: true,
            tension: 0.35,
            cubicInterpolationMode: 'monotone', // no dips below zero between points
            pointRadius: 3,
          },
        ],
      },
      options: {
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx: { parsed: { y: number | null } }) => fmtBD((ctx.parsed.y ?? 0).toFixed(2)) } } },
        scales: { y: { beginAtZero: true, min: 0 } },
      },
    }),
    [last7],
  )

  const topOptions = useCallback(
    () => ({
      data: {
        labels: top.map((p) => (p.name.length > 22 ? p.name.slice(0, 21) + '…' : p.name)),
        datasets: [{ label: 'Revenue', data: top.map((p) => num(p.revenue)), backgroundColor: cssToken('--ss-accent'), borderRadius: 4 }],
      },
      options: {
        indexAxis: 'y' as const,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx: { parsed: { x: number | null } }) => fmtBD((ctx.parsed.x ?? 0).toFixed(2)) } } },
        scales: { x: { beginAtZero: true }, y: { grid: { display: false } } },
      },
    }),
    [top],
  )

  return (
    <Row className="g-3">
      <Col xl={7}>
        <Card className="h-100 mb-0">
          <CardHeader className="border-0">
            <h5 className="card-title mb-0">Sales - last 7 days</h5>
          </CardHeader>
          <CardBody>
            {hasSales ? (
              <div style={{ height: 300 }}>
                <ChartJs type="line" height={300} getOptions={salesOptions} plugins={[LineController, LineElement, PointElement, Filler]} />
              </div>
            ) : (
              <EmptyState icon="chart-line" title="No sales yet" description="Sales from the last 7 days will appear here." className="py-5" />
            )}
          </CardBody>
        </Card>
      </Col>
      <Col xl={5}>
        <Card className="h-100 mb-0">
          <CardHeader className="border-0">
            <h5 className="card-title mb-0">Top products - last 30 days</h5>
          </CardHeader>
          <CardBody>
            {top.length > 0 ? (
              <div style={{ height: 300 }}>
                <ChartJs type="bar" height={300} getOptions={topOptions} plugins={[BarController, BarElement]} />
              </div>
            ) : (
              <EmptyState icon="package-search" title="No product sales yet" description="Your best sellers by revenue will appear here." className="py-5" />
            )}
          </CardBody>
        </Card>
      </Col>
    </Row>
  )
}

export default DashboardCharts
