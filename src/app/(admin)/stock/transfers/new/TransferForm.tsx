'use client'
import BarcodeScanButton from '@/components/scan/BarcodeScanButton'
import { appendScanLine } from '@/components/scan/scanLogic'
import SearchSelect, { type SearchOption } from '@/components/ui/SearchSelect'
import Icon from '@/components/wrappers/Icon'
import { createTransferAction, searchTransferProductsAction } from '@/server/actions/inventory'
import { newUuid } from '@/utils/uuid'
import { useRouter } from 'next/navigation'
import { useRef, useState, useTransition } from 'react'
import { Alert, Button, Col, Form, Row, Table } from 'react-bootstrap'

type Branch = { id: string; name: string; code: string }
type Line = { key: string; product: (SearchOption & { onHand?: number }) | null; qty: string }

/**
 * Immediate inter-branch transfer: serial units (scan / type their serials) and quantity lines. Everything moves in one
 * transaction on the server, or nothing does. A user restricted to one branch can only send from it (source locked).
 */
const TransferForm = ({ branches, defaultFrom, restrictedTo, today }: { branches: Branch[]; defaultFrom: string; restrictedTo: string | null; today: string }) => {
  const router = useRouter()
  const [from, setFrom] = useState(defaultFrom)
  const [to, setTo] = useState(branches.find((b) => b.id !== defaultFrom)?.id ?? '')
  const [date, setDate] = useState(today)
  const [note, setNote] = useState('')
  const [serials, setSerials] = useState('')
  const serialsRef = useRef('')
  const [lines, setLines] = useState<Line[]>([])
  const [error, setError] = useState<string | null>(null)
  const [fields, setFields] = useState<Record<string, string>>({})
  const [pending, start] = useTransition()
  const attempt = useRef(newUuid())
  const nameOf = (id: string) => branches.find((b) => b.id === id)?.name ?? ''

  const submit = () =>
    start(async () => {
      setError(null)
      setFields({})
      const r = await createTransferAction({
        fromBranchId: from,
        toBranchId: to,
        date,
        note,
        serials: [serials],
        lines: lines.filter((l) => l.product).map((l) => ({ productId: l.product!.value, qty: l.qty })),
        idempotencyKey: attempt.current,
      })
      if (r.ok) {
        router.push(`/stock/transfers/${r.data.id}`)
        router.refresh()
      } else {
        setError(r.error)
        setFields(r.fieldErrors ?? {})
      }
    })

  const branchOptions = branches.map((b) => (
    <option key={b.id} value={b.id}>
      {b.name} ({b.code})
    </option>
  ))
  const restrictedProblem = restrictedTo && from !== restrictedTo ? `You can only transfer stock out of ${nameOf(restrictedTo)}.` : null

  return (
    <Form
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      {error && <Alert variant="danger">{error}</Alert>}
      <Row className="g-3 mb-3">
        <Col md={3}>
          <Form.Label htmlFor="tr-from">From branch</Form.Label>
          <Form.Select id="tr-from" value={from} disabled={!!restrictedTo} onChange={(e) => { setFrom(e.target.value); setLines([]) }} isInvalid={!!fields.fromBranchId}>
            {branchOptions}
          </Form.Select>
          <Form.Control.Feedback type="invalid">{fields.fromBranchId}</Form.Control.Feedback>
        </Col>
        <Col md={3}>
          <Form.Label htmlFor="tr-to">To branch</Form.Label>
          <Form.Select id="tr-to" value={to} onChange={(e) => setTo(e.target.value)} isInvalid={!!fields.toBranchId || from === to}>
            {branchOptions}
          </Form.Select>
          <Form.Control.Feedback type="invalid">{from === to ? 'Choose two different branches' : fields.toBranchId}</Form.Control.Feedback>
        </Col>
        <Col md={3}>
          <Form.Label htmlFor="tr-date">Date</Form.Label>
          <Form.Control id="tr-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} isInvalid={!!fields.date} />
          <Form.Control.Feedback type="invalid">{fields.date}</Form.Control.Feedback>
        </Col>
        <Col md={3}>
          <Form.Label htmlFor="tr-note">Note</Form.Label>
          <Form.Control id="tr-note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
        </Col>
      </Row>
      {restrictedProblem && <Alert variant="warning" className="py-2">{restrictedProblem}</Alert>}

      <Row className="g-3">
        <Col lg={5}>
          <div className="d-flex justify-content-between align-items-end mb-1">
            <Form.Label htmlFor="tr-serials" className="mb-0">Serial units (one per line)</Form.Label>
            <BarcodeScanButton
              size="sm"
              continuous
              title="Scan serial numbers with the camera"
              onScan={(code) => {
                const next = appendScanLine(serialsRef.current, code)
                if (next === null) return false
                serialsRef.current = next
                setSerials(next)
              }}
            />
          </div>
          <Form.Control
            id="tr-serials"
            as="textarea"
            rows={8}
            className="font-monospace"
            value={serials}
            isInvalid={!!fields.serials}
            placeholder="Scan or type serial / IMEI numbers. Only units in stock at the source branch can move."
            onChange={(e) => {
              serialsRef.current = e.target.value
              setSerials(e.target.value)
            }}
          />
          <Form.Control.Feedback type="invalid">{fields.serials}</Form.Control.Feedback>
        </Col>
        <Col lg={7}>
          <div className="d-flex justify-content-between align-items-center mb-1">
            <span className="form-label mb-0">Quantity items</span>
            <Button size="sm" variant="light" onClick={() => setLines((ls) => [...ls, { key: newUuid(), product: null, qty: '1' }])}>
              <Icon icon="plus" className="me-1" /> Add item
            </Button>
          </div>
          {lines.length === 0 ? (
            <p className="text-muted small">Non-serial products (cables, accessories...). On-hand shown is at {nameOf(from)}.</p>
          ) : (
            <Table size="sm" className="align-middle">
              <tbody>
                {lines.map((l, i) => (
                  <tr key={l.key}>
                    <td style={{ minWidth: 220 }}>
                      <SearchSelect
                        loadOptions={(q) => searchTransferProductsAction(q, from)}
                        value={l.product}
                        invalid={!!fields[`lines.${i}.productId`]}
                        onChange={(o) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, product: o } : x)))}
                        placeholder="Product…"
                        ariaLabel={`Product line ${i + 1}`}
                      />
                      {fields[`lines.${i}.productId`] && <div className="invalid-feedback d-block">{fields[`lines.${i}.productId`]}</div>}
                    </td>
                    <td style={{ width: 120 }}>
                      <Form.Control type="number" min={1} step={1} value={l.qty} aria-label="Quantity" isInvalid={!!fields[`lines.${i}.qty`]} onChange={(e) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, qty: e.target.value } : x)))} />
                      <Form.Control.Feedback type="invalid">{fields[`lines.${i}.qty`]}</Form.Control.Feedback>
                    </td>
                    <td className="text-end" style={{ width: 40 }}>
                      <Button size="sm" variant="tonal-danger" className="btn-square" aria-label="Remove item" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                        <Icon icon="x" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {fields.lines && <div className="text-danger small">{fields.lines}</div>}
        </Col>
      </Row>
      <div className="d-flex justify-content-end gap-2 mt-3">
        <Button variant="light" onClick={() => router.push('/stock/transfers')}>Cancel</Button>
        <Button type="submit" disabled={pending || from === to || !!restrictedProblem}>
          {pending ? 'Transferring…' : `Transfer to ${nameOf(to)}`}
        </Button>
      </div>
    </Form>
  )
}

export default TransferForm
