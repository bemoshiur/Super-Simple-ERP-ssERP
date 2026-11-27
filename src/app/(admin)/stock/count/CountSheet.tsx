'use client'
import BarcodeScanButton from '@/components/scan/BarcodeScanButton'
import { appendScanLine } from '@/components/scan/scanLogic'
import SearchSelect, { type SearchOption } from '@/components/ui/SearchSelect'
import Icon from '@/components/wrappers/Icon'
import { searchCategoriesAction } from '@/server/actions/catalog'
import { applyCountAction, countDiffAction, loadCountSheetAction } from '@/server/actions/inventory'
import type { CountDiff, CountSheetRow } from '@/server/inventory/count'
import { UNEXPECTED_LABEL, mergeReloadedCounts, type MovedProduct } from '@/server/inventory/pure'
import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Badge, Button, Col, Form, Row, Table } from 'react-bootstrap'
import { newUuid } from '@/utils/uuid'

const newKey = newUuid

/**
 * Stock-take: load a sheet (category / search / tracking), enter counted quantities for quantity products and scan the
 * serials of serial products, then compute the difference report (on screen + CSV). "Apply" creates count-correction
 * adjustments for QUANTITY products only, in one transaction; serial discrepancies are reported, never changed.
 */
const CountSheet = ({ canViewSerials }: { canViewSerials: boolean }) => {
  const [category, setCategory] = useState<SearchOption | null>(null)
  const [q, setQ] = useState('')
  const [tracking, setTracking] = useState<'all' | 'serial' | 'plain'>('all')
  const [sheet, setSheet] = useState<CountSheetRow[] | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [counted, setCounted] = useState<Record<string, string>>({})
  const [scanned, setScanned] = useState('')
  // Latest scanned text, updated synchronously, so two quick camera reads never overwrite each other.
  const scannedRef = useRef('')
  useEffect(() => {
    scannedRef.current = scanned
  }, [scanned])
  const [diff, setDiff] = useState<CountDiff | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<null | 'load' | 'diff' | 'apply'>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [moved, setMoved] = useState<MovedProduct[]>([])
  const [stale, setStale] = useState(false)
  const [key, setKey] = useState(newKey)
  const csvForm = useRef<HTMLFormElement>(null)

  const plain = useMemo(() => (sheet ?? []).filter((r) => !r.trackSerial), [sheet])
  const serial = useMemo(() => (sheet ?? []).filter((r) => r.trackSerial), [sheet])
  const payload = () => ({ lines: plain.map((r) => ({ productId: r.productId, counted: counted[r.productId] ?? '', system: r.system })), serialProductIds: serial.map((r) => r.productId), scanned })
  const badQty = plain.filter((r) => (counted[r.productId] ?? '').trim() !== '' && !/^\d{1,9}$/.test((counted[r.productId] ?? '').trim()))
  const toApply = diff ? diff.rows.filter((r) => r.diff !== 0) : []

  const load = async () => {
    setBusy('load')
    setError(null)
    setDone(null)
    setDiff(null)
    const res = await loadCountSheetAction({ categoryId: category?.value ?? '', q, tracking })
    setBusy(null)
    if (!res.ok) return setError(res.error)
    // Reload keeps every count whose product did not move since the last load; only moved products are cleared (and listed).
    const merged = sheet ? mergeReloadedCounts(sheet, res.data.rows, counted) : { counted: {}, moved: [] }
    setSheet(res.data.rows)
    setTruncated(res.data.truncated)
    setCounted(merged.counted)
    setMoved(merged.moved)
    if (!sheet) setScanned('')
    setStale(false)
    setKey(newKey())
  }

  const compute = async () => {
    if (badQty.length) return setError(`Counted quantities must be whole numbers: ${badQty.map((r) => r.name).join(', ')}`)
    setBusy('diff')
    setError(null)
    setDone(null)
    const res = await countDiffAction(payload())
    setBusy(null)
    if (!res.ok) return setError(res.error)
    setDiff(res.data)
  }

  const apply = async (onlyUnchanged = false) => {
    if (!diff || busy) return
    const what = onlyUnchanged ? 'Apply the corrections for products whose stock did not move since the count? Moved products are skipped.' : `Apply ${toApply.length} count correction${toApply.length === 1 ? '' : 's'} to quantity products? Serial units are not changed.`
    if (!window.confirm(what)) return
    setBusy('apply')
    setError(null)
    const res = await applyCountAction({ lines: plain.filter((r) => (counted[r.productId] ?? '').trim() !== '').map((r) => ({ productId: r.productId, counted: counted[r.productId], system: r.system })), note, idempotencyKey: key, onlyUnchanged })
    setBusy(null)
    if (!res.ok) {
      setKey(newKey())
      setStale(/Stock changed since the count/.test(res.error))
      return setError(res.error)
    }
    setStale(false)
    const skipped = res.data.skipped.length ? ` Skipped (stock moved, recount): ${res.data.skipped.map((x) => `${x.name} (was ${x.expected}, now ${x.now})`).join('; ')}.` : ''
    setDone(res.data.duplicate ? 'This count was already applied.' : `Applied ${res.data.applied.length} correction${res.data.applied.length === 1 ? '' : 's'}.${skipped} Reload the sheet to continue counting.`)
    setDiff(null)
    setSheet(null)
  }

  return (
    <>
      <div className="d-flex flex-wrap gap-2 align-items-end mb-3">
        <div style={{ minWidth: 220 }}>
          <Form.Label className="small text-muted mb-1">Category</Form.Label>
          <SearchSelect loadOptions={searchCategoriesAction} value={category} onChange={setCategory} placeholder="All categories" />
        </div>
        <div>
          <Form.Label className="small text-muted mb-1" htmlFor="cnt-q">
            Name or SKU
          </Form.Label>
          <Form.Control id="cnt-q" size="sm" maxLength={100} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Optional" />
        </div>
        <div>
          <Form.Label className="small text-muted mb-1" htmlFor="cnt-t">
            Products
          </Form.Label>
          <Form.Select id="cnt-t" size="sm" value={tracking} onChange={(e) => setTracking(e.target.value as typeof tracking)}>
            <option value="all">Serial and quantity</option>
            <option value="plain">Quantity only</option>
            <option value="serial">Serial-tracked only</option>
          </Form.Select>
        </div>
        <Button size="sm" onClick={() => void load()} disabled={busy !== null}>
          <Icon icon="clipboard-list" className="me-1" />
          {busy === 'load' ? 'Loading…' : sheet ? 'Reload sheet' : 'Load count sheet'}
        </Button>
        <Link href="/stock" className="btn btn-sm btn-light ms-auto">
          Back to stock
        </Link>
      </div>

      {error && (
        <Alert variant="danger" style={{ overflowWrap: 'anywhere' }}>
          {error}
        </Alert>
      )}
      {stale && (
        <Alert variant="warning" className="d-flex flex-wrap align-items-center gap-2">
          <span className="flex-grow-1">Reload the sheet to keep your counts for unchanged products and recount only the moved ones, or apply just the unchanged lines now.</span>
          <Button size="sm" variant="warning" disabled={busy !== null} onClick={() => void apply(true)}>
            Apply unchanged lines only
          </Button>
        </Alert>
      )}
      {moved.length > 0 && (
        <Alert variant="warning" dismissible onClose={() => setMoved([])}>
          Stock moved since the last load for: {moved.map((x) => `${x.name} (was ${x.was}, now ${x.now})`).join('; ')}.{' '}
          {moved.some((x) => !x.trackSerial) && 'Their counts were cleared: count them again. '}
          {moved.some((x) => x.trackSerial) && 'Scanned serials were kept: rescan the moved serial products if needed. '}
          All other counts were kept.
        </Alert>
      )}
      {done && <Alert variant="success">{done}</Alert>}
      {truncated && <Alert variant="warning">Only the first 500 products are shown. Narrow the category or search to count the rest.</Alert>}

      {sheet && sheet.length === 0 && <Alert variant="info">No products match. Change the filters and load again.</Alert>}

      {sheet && sheet.length > 0 && (
        <Row className="g-3">
          {plain.length > 0 && (
            <Col lg={serial.length ? 7 : 12}>
              <h5 className="mb-2">Quantity products</h5>
              <p className="small text-muted">Leave a box empty to skip that product. The system quantity is as of when the sheet was loaded.</p>
              <div className="table-responsive" style={{ maxHeight: 480, overflowY: 'auto' }}>
                <Table size="sm" className="align-middle mb-0">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th className="text-end">System</th>
                      <th className="text-end" style={{ width: 120 }}>
                        Counted
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {plain.map((r) => {
                      const v = counted[r.productId] ?? ''
                      return (
                        <tr key={r.productId}>
                          <td>
                            {r.name}
                            <div className="small text-muted">{r.sku}</div>
                          </td>
                          <td className="text-end">{r.system}</td>
                          <td>
                            <Form.Control
                              size="sm"
                              inputMode="numeric"
                              className="text-end"
                              aria-label={`Counted ${r.name}`}
                              value={v}
                              onChange={(e) => {
                                setDiff(null)
                                setCounted((s) => ({ ...s, [r.productId]: e.target.value }))
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') e.preventDefault()
                              }}
                              isInvalid={v.trim() !== '' && !/^\d{1,9}$/.test(v.trim())}
                            />
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </Table>
              </div>
            </Col>
          )}
          {serial.length > 0 && (
            <Col lg={plain.length ? 5 : 12}>
              <h5 className="mb-2">Serial products</h5>
              <ul className="small mb-2">
                {serial.map((r) => (
                  <li key={r.productId}>
                    {r.name} · <span className="text-muted">{r.system} in stock</span>
                  </li>
                ))}
              </ul>
              <div className="d-flex justify-content-between align-items-end gap-2 mb-1">
                <Form.Label htmlFor="cnt-serials" className="mb-0">
                  Scanned serials (one per line, or separated by commas)
                </Form.Label>
                <BarcodeScanButton
                  size="sm"
                  continuous
                  title="Scan units on the shelf with the camera"
                  onScan={(code) => {
                    const next = appendScanLine(scannedRef.current, code)
                    if (next === null) return false
                    scannedRef.current = next
                    setDiff(null)
                    setScanned(next)
                  }}
                />
              </div>
              <Form.Control id="cnt-serials" as="textarea" rows={10} className="font-monospace" value={scanned} onChange={(e) => {
                  setDiff(null)
                  setScanned(e.target.value)
                }} placeholder="Scan each unit on the shelf…" />
            </Col>
          )}
          <Col xs={12} className="d-flex flex-wrap gap-2">
            <Button onClick={() => void compute()} disabled={busy !== null}>
              <Icon icon="git-compare" className="me-1" />
              {busy === 'diff' ? 'Comparing…' : 'Compare with system'}
            </Button>
            <Button
              variant="tonal-secondary"
              disabled={busy !== null}
              onClick={() => {
                const f = csvForm.current
                if (!f) return
                ;(f.elements.namedItem('payload') as HTMLInputElement).value = JSON.stringify(payload())
                f.submit()
              }}
            >
              <Icon icon="download" className="me-1" /> Download difference CSV
            </Button>
          </Col>
        </Row>
      )}
      <form ref={csvForm} method="post" action="/stock/count/csv" className="d-none">
        <input type="hidden" name="payload" />
      </form>

      {diff && (
        <div className="mt-4">
          <h5>
            Difference report{' '}
            <small className="text-muted fw-normal">
              {diff.totals.counted} counted · {diff.totals.over} over · {diff.totals.short} short · {diff.totals.missing} missing serial{diff.totals.missing === 1 ? '' : 's'} · {diff.totals.unexpected} unexpected
            </small>
          </h5>
          {diff.rows.length > 0 && (
            <Table size="sm" responsive className="align-middle">
              <thead>
                <tr>
                  <th>Product</th>
                  <th className="text-end">System now</th>
                  <th className="text-end">Counted</th>
                  <th className="text-end">Difference</th>
                </tr>
              </thead>
              <tbody>
                {diff.rows.map((r) => (
                  <tr key={r.productId}>
                    <td>
                      <Link href={`/products/${r.productId}`}>{r.name}</Link>
                    </td>
                    <td className="text-end">{r.system}</td>
                    <td className="text-end">{r.counted}</td>
                    <td className={`text-end fw-semibold ${r.diff < 0 ? 'text-danger' : r.diff > 0 ? 'text-success' : 'text-muted'}`}>{r.diff > 0 ? `+${r.diff}` : r.diff}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {(diff.missing.length > 0 || diff.unexpected.length > 0 || diff.duplicates.length > 0) && (
            <Row className="g-3 mb-3">
              <Col md={6}>
                <h6>Missing serials ({diff.missing.length})</h6>
                <p className="small text-muted mb-1">The system says these are in stock, but they were not scanned.</p>
                <ul className="small font-monospace mb-0" style={{ maxHeight: 240, overflowY: 'auto' }}>
                  {diff.missing.map((m) => (
                    <li key={m.unitId}>
                      {canViewSerials ? <Link href={`/serials/${m.unitId}`}>{m.serialNo}</Link> : m.serialNo} <span className="text-muted font-sans">· {m.productName}</span>
                    </li>
                  ))}
                </ul>
              </Col>
              <Col md={6}>
                <h6>Unexpected serials ({diff.unexpected.length})</h6>
                <ul className="small mb-0" style={{ maxHeight: 240, overflowY: 'auto' }}>
                  {diff.unexpected.map((x) => (
                    <li key={x.serialNo}>
                      <span className="font-monospace">{canViewSerials && x.unitId ? <Link href={`/serials/${x.unitId}`}>{x.serialNo}</Link> : x.serialNo}</span> <span className="text-muted">· {UNEXPECTED_LABEL[x.reason]}{x.status ? ` (${x.status.replace(/_/g, ' ')})` : ''}{x.productName ? ` · ${x.productName}` : ''}</span>
                    </li>
                  ))}
                </ul>
                {diff.duplicates.length > 0 && <p className="small text-muted mt-2 mb-0">Scanned more than once (counted once): {diff.duplicates.join(', ')}</p>}
              </Col>
            </Row>
          )}
          <div className="border rounded p-3 bg-light-subtle">
            <div className="d-flex flex-wrap align-items-end gap-2">
              <div className="flex-grow-1">
                <Form.Label htmlFor="cnt-note" className="small mb-1">
                  Note for the adjustments
                </Form.Label>
                <Form.Control id="cnt-note" size="sm" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Monthly count, shelf A" />
              </div>
              <Button variant="primary" disabled={busy !== null || toApply.length === 0} onClick={() => void apply(false)}>
                {busy === 'apply' ? 'Applying…' : `Apply ${toApply.length} correction${toApply.length === 1 ? '' : 's'}`}
              </Button>
            </div>
            <p className="small text-muted mb-0 mt-2">
              <Badge bg="info-subtle" text="info" className="me-1">
                Note
              </Badge>
              Only quantity products are adjusted (reason: count correction), all in one step. If stock moved since the sheet was loaded, nothing is applied and you are asked to recount. Serial discrepancies are never changed automatically: investigate them on the serial pages.
            </p>
          </div>
        </div>
      )}
    </>
  )
}

export default CountSheet
