'use client'
import MoneyText from '@/components/ui/MoneyText'
import BarcodeScanButton from '@/components/scan/BarcodeScanButton'
import SearchSelect, { type SearchOption } from '@/components/ui/SearchSelect'
import Icon from '@/components/wrappers/Icon'
import { createSaleAction, lookupSaleSerialAction, searchSaleCustomersAction, searchSaleProductsAction } from '@/server/actions/sales'
import { fromMinor, toMinor } from '@/server/money'
import { normalizeSerial } from '@/server/purchases/serialInput'
import type { SaleProductOption } from '@/server/sales/sales'
import { MAX_PAYMENTS_PER_SALE } from '@/server/sales/schemas'
import { computeSaleTotals } from '@/server/sales/totals'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Badge, Button, Card, CardBody, Col, Form, Row, Table } from 'react-bootstrap'
import { newUuid } from '@/utils/uuid'

type Account = { id: string; name: string; type: string }
type Line = {
  key: string
  kind: 'serial' | 'product'
  serial?: string
  productId: string
  name: string
  sku?: string
  warrantyMonths?: number
  onHand?: number
  qty: string
  unitPrice: string
  /** Unit cost, only present when the role may see profit. */
  cost?: string
}
type PayRow = { key: string; accountId: string; amount: string; method: string }

let seq = 0
const k = () => `k${++seq}`
const safeMinor = (v: string): number | null => {
  try {
    return toMinor(v.trim() === '' ? '0' : v.trim())
  } catch {
    return null
  }
}

/**
 * Scan-first POS form. The big serial box keeps focus: scan (scanners end with Enter) -> the server looks the unit up ->
 * a line is added with the product's sale price (editable) -> focus returns to the box. Loose stock is added by product.
 * Totals are previewed with the same pure function the server uses; the server recomputes and re-checks everything.
 */
const SaleForm = ({ accounts, today, showProfit }: { accounts: Account[]; today: string; showProfit: boolean }) => {
  const router = useRouter()
  const scanRef = useRef<HTMLInputElement>(null)
  // One key per save attempt: a double click, retry or resubmit after a timeout returns the same invoice.
  const newKey = newUuid
  const attemptKey = useRef<string>(newKey())
  // After a failed attempt, any change to the cart/payments/customer/discount is a NEW attempt (new key); an unchanged
  // resubmit keeps the key, so a save that did reach the server is returned instead of duplicated.
  const failed = useRef(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [scanText, setScanText] = useState('')
  const [scanError, setScanError] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [lastAdded, setLastAdded] = useState<string | null>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [customer, setCustomer] = useState<SearchOption | null>(null)
  const [date, setDate] = useState(today)
  const [note, setNote] = useState('')
  const [discount, setDiscount] = useState('')
  const cashId = accounts.find((a) => a.type === 'cash')?.id ?? accounts[0]?.id ?? ''
  const [pays, setPays] = useState<PayRow[]>(() => [{ key: k(), accountId: cashId, amount: '', method: '' }])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (failed.current) {
      attemptKey.current = newKey()
      failed.current = false
    }
  }, [lines, pays, customer, discount])

  const sentPays = pays.filter((p) => p.amount.trim() !== '')
  const totals = useMemo(() => computeSaleTotals({ items: lines.map((l) => ({ qty: l.qty, unitPrice: l.unitPrice })), discount, payments: pays.filter((p) => p.amount.trim() !== '').map((p) => p.amount) }), [lines, discount, pays])
  const err = (key: string) => errors[key] ?? (!totals.ok ? totals.errors[key] : undefined)
  const unitCount = lines.reduce((a, l) => a + (/^\d+$/.test(l.qty.trim()) ? Number(l.qty.trim()) : 0), 0)
  const profit = useMemo(() => {
    if (!showProfit || !totals.ok || lines.some((l) => l.cost === undefined)) return null
    return fromMinor(lines.reduce((a, l, i) => a + toMinor(totals.totals.netLines[i]) - toMinor(l.cost as string) * Number(l.qty), 0))
  }, [showProfit, totals, lines])

  const refocus = () => setTimeout(() => scanRef.current?.focus(), 0)
  const updateLine = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  const updatePay = (key: string, patch: Partial<PayRow>) => setPays((ps) => ps.map((p) => (p.key === key ? { ...p, ...patch } : p)))

  /** Add a serial to the invoice. `camera` is a code read by the camera; typed / USB-scanner input comes from the box (Enter). Returns whether it was added. */
  const scan = async (camera?: string): Promise<boolean> => {
    const s = normalizeSerial(camera ?? scanText)
    if (!s || scanning) return false
    if (lines.some((l) => l.serial === s)) {
      setScanError(`Serial ${s} is already on this invoice.`)
      scanRef.current?.select()
      return false
    }
    setScanning(true)
    const res = await lookupSaleSerialAction(s)
    setScanning(false)
    if (!res.ok) {
      setScanError(res.error)
      scanRef.current?.select()
      return false
    }
    const u = res.data
    setLines((ls) => (ls.some((l) => l.serial === u.serial) ? ls : [...ls, { key: k(), kind: 'serial', serial: u.serial, productId: u.productId, name: u.productName, sku: u.sku, warrantyMonths: u.warrantyMonths, qty: '1', unitPrice: u.salePrice, cost: u.cost }]))
    setScanText('')
    setScanError(null)
    setLastAdded(`${u.productName} · ${u.serial}`)
    refocus()
    return true
  }

  const addProduct = (o: SearchOption | null) => {
    const p = o as SaleProductOption | null
    if (!p) return
    setLines((ls) => {
      const existing = ls.find((l) => l.kind === 'product' && l.productId === p.value)
      if (existing) return ls.map((l) => (l === existing ? { ...l, qty: String((Number(l.qty) || 0) + 1) } : l))
      return [...ls, { key: k(), kind: 'product', productId: p.value, name: p.label, onHand: p.onHand, qty: '1', unitPrice: p.salePrice, cost: p.cost }]
    })
    setLastAdded(p.label)
    refocus()
  }

  const fillRemaining = (key: string) => {
    const total = computeSaleTotals({ items: lines.map((l) => ({ qty: l.qty, unitPrice: l.unitPrice })), discount })
    if (!total.ok) return
    const others = pays.filter((p) => p.key !== key).reduce((a, p) => a + (safeMinor(p.amount) ?? 0), 0)
    updatePay(key, { amount: fromMinor(Math.max(0, toMinor(total.totals.total) - others)) })
  }

  const localProblem = (): string | null => {
    if (lines.length === 0) return 'Scan a serial or add a product first.'
    if (!totals.ok) return 'Fix the highlighted amounts.'
    if (!customer && totals.totals.due !== '0.00') return 'A walk-in sale must be paid in full. Choose a customer to leave an amount due.'
    if (sentPays.some((p) => !p.accountId)) return 'Choose an account for every payment.'
    for (const l of lines) if (l.kind === 'product' && l.onHand !== undefined && Number(l.qty) > l.onHand) return `Only ${l.onHand} of ${l.name} in stock.`
    return null
  }

  const submit = async (thenPrint: boolean) => {
    if (saving) return
    setFormError(null)
    setErrors({})
    const problem = localProblem()
    if (problem) return setFormError(problem)
    setSaving(true)
    const res = await createSaleAction({
      customerId: customer?.value ?? null,
      date,
      note,
      items: lines.map((l) => (l.kind === 'serial' ? { serial: l.serial, qty: 1, unitPrice: l.unitPrice } : { productId: l.productId, qty: l.qty, unitPrice: l.unitPrice })),
      discount,
      payments: sentPays.map((p) => ({ accountId: p.accountId, amount: p.amount, method: p.method })),
      expectedTotal: totals.ok ? totals.totals.total : undefined,
      idempotencyKey: attemptKey.current || undefined,
    })
    if (res.ok) {
      const go = () => router.push(thenPrint ? `/sales/${res.data.id}/print` : `/sales/${res.data.id}`)
      if (res.data.duplicate) {
        setNotice(`This sale was already saved as ${res.data.invoiceNo}. Opening it…`)
        setTimeout(go, 1500)
      } else go()
      return
    }
    failed.current = true
    setSaving(false)
    // payments.N refers to the rows actually sent; map those errors back to the visible rows.
    const fe: Record<string, string> = {}
    for (const [key, v] of Object.entries(res.fieldErrors ?? {})) {
      const m = /^payments\.(\d+)\.(.+)$/.exec(key)
      fe[m && sentPays[Number(m[1])] ? `pay.${sentPays[Number(m[1])].key}.${m[2]}` : key] = v
    }
    setErrors(fe)
    setFormError(res.error)
  }

  return (
    <Form
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        void submit(false)
      }}
      onKeyDown={(e) => {
        // Barcode scanners end with Enter: never submit from a single-line input by accident.
        if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') e.preventDefault()
      }}
    >
      {notice && (
        <Alert variant="info" role="status">
          {notice}
        </Alert>
      )}
      {formError && (
        <Alert variant="danger" style={{ overflowWrap: 'anywhere' }}>
          {formError}
          {errors.items && <div>{errors.items}</div>}
          {errors._ && <div>{errors._}</div>}
        </Alert>
      )}
      <Row>
        <Col xl={8}>
          <Card>
            <CardBody>
              <Form.Label htmlFor="scan" className="fw-semibold">
                Scan serial / IMEI
              </Form.Label>
              <div className="d-flex gap-2">
                <Form.Control
                  id="scan"
                  ref={scanRef}
                  size="lg"
                  autoFocus
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  className="font-monospace"
                  placeholder="Scan or type, then Enter"
                  value={scanText}
                  isInvalid={!!scanError}
                  onChange={(e) => {
                    setScanText(e.target.value)
                    if (scanError) setScanError(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void scan()
                    }
                  }}
                  aria-describedby="scan-help"
                />
                <BarcodeScanButton size="lg" label="" title="Scan a serial with the camera" disabled={scanning} onScan={(code) => scan(code)} />
                <Button size="lg" variant="primary" onClick={() => void scan()} disabled={scanning || !scanText.trim()} aria-label="Add scanned serial">
                  {scanning ? '…' : <Icon icon="corner-down-left" />}
                </Button>
              </div>
              <div id="scan-help" className="small mt-1" aria-live="polite">
                {scanError ? <span className="text-danger">{scanError}</span> : lastAdded ? <span className="text-success">Added: {lastAdded}</span> : <span className="text-muted">The unit&apos;s product and sale price are filled in for you.</span>}
              </div>
              <div className="mt-3" style={{ maxWidth: 420 }}>
                <Form.Label htmlFor="add-product" className="small text-muted mb-1">
                  Or add an item without serial numbers
                </Form.Label>
                <SearchSelect id="add-product" loadOptions={searchSaleProductsAction} value={null} onChange={addProduct} placeholder="Search product or SKU…" />
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardBody>
              <div className="d-flex justify-content-between align-items-center mb-2">
                <h5 className="mb-0">Items</h5>
                <span className="text-muted small">
                  {lines.length} line{lines.length === 1 ? '' : 's'}, {unitCount} unit{unitCount === 1 ? '' : 's'}
                </span>
              </div>
              {lines.length === 0 ? (
                <div className="text-muted text-center py-4">Nothing added yet. Scan a serial to start.</div>
              ) : (
                <div className="table-responsive">
                  <Table className="align-middle mb-0">
                    <thead>
                      <tr>
                        <th style={{ width: 32 }}>#</th>
                        <th style={{ minWidth: 220 }}>Item</th>
                        <th style={{ width: 100 }}>Qty</th>
                        <th style={{ width: 150 }}>Unit price</th>
                        <th className="text-end" style={{ width: 140 }}>
                          Amount
                        </th>
                        <th style={{ width: 44 }} />
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((l, i) => {
                        const ek = (f: string) => err(`items.${i}.${f}`)
                        const lineErr = ek('serial') ?? ek('productId')
                        return (
                          <tr key={l.key}>
                            <td className="text-muted">{i + 1}</td>
                            <td>
                              <div className="fw-semibold">{l.name}</div>
                              {l.kind === 'serial' ? (
                                <div className="small">
                                  <Badge bg="primary-subtle" text="primary" className="font-monospace fw-normal">
                                    {l.serial}
                                  </Badge>{' '}
                                  <span className="text-muted">{l.warrantyMonths ? `${l.warrantyMonths} month${l.warrantyMonths === 1 ? '' : 's'} warranty` : 'No warranty'}</span>
                                </div>
                              ) : (
                                <div className="small text-muted">{l.onHand !== undefined ? `${l.onHand} in stock` : ''}</div>
                              )}
                              {lineErr && <div className="small text-danger">{lineErr}</div>}
                            </td>
                            <td>
                              {l.kind === 'serial' ? (
                                <span className="ps-2">1</span>
                              ) : (
                                <>
                                  <Form.Control size="sm" inputMode="numeric" value={l.qty} onChange={(e) => updateLine(l.key, { qty: e.target.value })} isInvalid={!!ek('qty')} aria-label={`Quantity line ${i + 1}`} />
                                  {ek('qty') && <Form.Control.Feedback type="invalid">{ek('qty')}</Form.Control.Feedback>}
                                </>
                              )}
                            </td>
                            <td>
                              <Form.Control size="sm" inputMode="decimal" className="text-end" value={l.unitPrice} onChange={(e) => updateLine(l.key, { unitPrice: e.target.value })} isInvalid={!!ek('unitPrice')} aria-label={`Unit price line ${i + 1}`} />
                              {ek('unitPrice') && <Form.Control.Feedback type="invalid">{ek('unitPrice')}</Form.Control.Feedback>}
                            </td>
                            <td className="text-end">{totals.ok ? <MoneyText value={totals.totals.lines[i]} /> : '-'}</td>
                            <td>
                              <Button
                                size="sm"
                                variant="tonal-danger"
                                className="btn-square"
                                aria-label={`Remove line ${i + 1}`}
                                onClick={() => {
                                  setLines((ls) => ls.filter((x) => x.key !== l.key))
                                  setErrors({})
                                  refocus()
                                }}
                              >
                                <Icon icon="trash-2" />
                              </Button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </Table>
                </div>
              )}
            </CardBody>
          </Card>
        </Col>

        <Col xl={4}>
          <Card>
            <CardBody>
              <Form.Label htmlFor="customer">Customer</Form.Label>
              <SearchSelect id="customer" loadOptions={searchSaleCustomersAction} value={customer} onChange={setCustomer} placeholder="Walk-in customer (search to pick)" invalid={!!errors.customerId} />
              {errors.customerId ? <div className="invalid-feedback d-block">{errors.customerId}</div> : !customer && <div className="small text-muted mt-1">Walk-in: must be paid in full.</div>}
              <Row className="g-2 mt-1">
                <Col xs={6}>
                  <Form.Label htmlFor="date" className="small mb-1">
                    Date
                  </Form.Label>
                  <Form.Control id="date" size="sm" type="date" value={date} onChange={(e) => setDate(e.target.value)} isInvalid={!!errors.date} />
                  {errors.date && <Form.Control.Feedback type="invalid">{errors.date}</Form.Control.Feedback>}
                </Col>
                <Col xs={6}>
                  <Form.Label htmlFor="note" className="small mb-1">
                    Note
                  </Form.Label>
                  <Form.Control id="note" size="sm" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
                </Col>
              </Row>
            </CardBody>
          </Card>

          <Card>
            <CardBody>
              <dl className="row mb-2">
                <dt className="col-6 fw-normal">Subtotal</dt>
                <dd className="col-6 text-end">{totals.ok ? <MoneyText value={totals.totals.subtotal} /> : '-'}</dd>
                <dt className="col-6 fw-normal">
                  <Form.Label htmlFor="discount" className="mb-0">
                    Discount
                  </Form.Label>
                </dt>
                <dd className="col-6">
                  <Form.Control id="discount" size="sm" className="text-end" inputMode="decimal" placeholder="0.00" value={discount} onChange={(e) => setDiscount(e.target.value)} isInvalid={!!err('discount')} />
                  {err('discount') && <Form.Control.Feedback type="invalid">{err('discount')}</Form.Control.Feedback>}
                </dd>
                <dt className="col-6 fs-5">Total</dt>
                <dd className="col-6 text-end fw-semibold fs-4">{totals.ok ? <MoneyText value={totals.totals.total} /> : '-'}</dd>
                {errors.total && <dd className="col-12 text-danger small">{errors.total}</dd>}
              </dl>

              <div className="fw-semibold mb-1">Payments</div>
              {pays.map((p, i) => (
                <div key={p.key} className="border rounded p-2 mb-2">
                  <div className="d-flex gap-2">
                    <Form.Select size="sm" aria-label={`Payment ${i + 1} account`} value={p.accountId} onChange={(e) => updatePay(p.key, { accountId: e.target.value })} isInvalid={!!errors[`pay.${p.key}.accountId`]}>
                      <option value="">Account…</option>
                      {accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </Form.Select>
                    <Form.Control size="sm" className="text-end" inputMode="decimal" placeholder="0.00" aria-label={`Payment ${i + 1} amount`} value={p.amount} onChange={(e) => updatePay(p.key, { amount: e.target.value })} isInvalid={!!errors[`pay.${p.key}.amount`] || safeMinor(p.amount) === null} />
                    <Button size="sm" variant="tonal-secondary" onClick={() => fillRemaining(p.key)} title="Fill the remaining amount">
                      Full
                    </Button>
                    {pays.length > 1 && (
                      <Button size="sm" variant="tonal-danger" className="btn-square" aria-label={`Remove payment ${i + 1}`} onClick={() => setPays((ps) => ps.filter((x) => x.key !== p.key))}>
                        <Icon icon="x" />
                      </Button>
                    )}
                  </div>
                  {p.amount.trim() !== '' && <Form.Control size="sm" className="mt-1" placeholder="Method / TrxID (optional)" maxLength={50} value={p.method} onChange={(e) => updatePay(p.key, { method: e.target.value })} aria-label={`Payment ${i + 1} reference`} />}
                  {(errors[`pay.${p.key}.accountId`] || errors[`pay.${p.key}.amount`]) && <div className="small text-danger mt-1">{errors[`pay.${p.key}.accountId`] ?? errors[`pay.${p.key}.amount`]}</div>}
                </div>
              ))}
              {pays.length < MAX_PAYMENTS_PER_SALE && (
                <Button size="sm" variant="link" className="p-0 mb-2" onClick={() => setPays((ps) => [...ps, { key: k(), accountId: '', amount: '', method: '' }])}>
                  + Split payment (cash / bank / mobile)
                </Button>
              )}
              {err('paid') && <div className="small text-danger mb-2">{err('paid')}</div>}

              <dl className="row mb-0">
                <dt className="col-6 fw-normal">Paid</dt>
                <dd className="col-6 text-end">{totals.ok ? <MoneyText value={totals.totals.paid} /> : '-'}</dd>
                <dt className="col-6">Due</dt>
                <dd className="col-6 text-end fw-semibold">{totals.ok ? <MoneyText value={totals.totals.due} className={totals.totals.due !== '0.00' ? 'text-danger' : undefined} /> : '-'}</dd>
                {profit !== null && (
                  <>
                    <dt className="col-6 fw-normal text-muted small">Est. profit</dt>
                    <dd className="col-6 text-end small">
                      <MoneyText value={profit} tone />
                    </dd>
                  </>
                )}
              </dl>
              <div className="d-grid gap-2 mt-3">
                <Button type="submit" size="lg" disabled={saving || lines.length === 0}>
                  {saving ? 'Saving…' : 'Save sale'}
                </Button>
                <Button variant="tonal-primary" disabled={saving || lines.length === 0} onClick={() => void submit(true)}>
                  <Icon icon="printer" className="me-1" /> Save and print
                </Button>
              </div>
            </CardBody>
          </Card>
        </Col>
      </Row>
    </Form>
  )
}

export default SaleForm
