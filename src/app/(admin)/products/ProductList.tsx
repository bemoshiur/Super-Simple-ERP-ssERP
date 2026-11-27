'use client'
import ConfirmDelete from '@/components/ui/ConfirmDelete'
import FormField, { FormProvider, useZodForm } from '@/components/ui/FormField'
import MoneyText from '@/components/ui/MoneyText'
import PaginatedTable from '@/components/ui/PaginatedTable'
import PickerField from '@/components/ui/PickerField'
import SearchSelect, { type SearchOption } from '@/components/ui/SearchSelect'
import StatusFilter, { type StatusValue } from '@/components/ui/StatusFilter'
import { applyActionErrors, toConfirmResult } from '@/components/ui/actionUi'
import HistoryButton from '@/components/ui/HistoryButton'
import Icon from '@/components/wrappers/Icon'
import { activateProductAction, createProductAction, deactivateProductAction, searchBrandsAction, searchCategoriesAction, suggestSkuAction, updateProductAction } from '@/server/actions/catalog'
import { productSchema } from '@/server/catalog/schemas'
import type { ColumnDef } from '@tanstack/react-table'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useMemo, useState, useTransition } from 'react'
import { Alert, Badge, Button, Col, Modal, Row } from 'react-bootstrap'

/**
 * purchasePrice is the product's editable LIST purchase price (a default for new purchase lines). It is cost information:
 * the server omits it from the rows for users without profit visibility (productRowsForClient), the column and form field
 * are hidden, and updateProductAction keeps the stored value for such users whatever the client sends.
 */
export type ProductListRow = {
  id: string
  name: string
  sku: string
  categoryId: string | null
  categoryName: string | null
  brandId: string | null
  brandName: string | null
  trackSerial: boolean
  warrantyMonths: number
  purchasePrice?: string
  salePrice: string
  lowStockThreshold: number
  active: boolean
}

type Props = {
  rows: ProductListRow[]
  total: number
  page: number
  pageSize: number
  q: string
  status: StatusValue
  category: SearchOption | null
  brand: SearchOption | null
  can: { create: boolean; edit: boolean; delete: boolean }
  /** Profit visibility: without it the purchase price column and form field are hidden (and the server keeps the stored value). */
  showCost: boolean
}

const ProductModal = ({ row, onHide, showCost }: { row: ProductListRow | null; onHide: () => void; showCost: boolean }) => {
  const form = useZodForm(productSchema, {
    defaultValues: {
      name: row?.name ?? '',
      sku: row?.sku ?? '',
      categoryId: row?.categoryId ?? '',
      brandId: row?.brandId ?? '',
      trackSerial: row?.trackSerial ?? false,
      warrantyMonths: String(row?.warrantyMonths ?? 0),
      purchasePrice: showCost ? (row?.purchasePrice ?? '') : '',
      salePrice: row?.salePrice ?? '',
      lowStockThreshold: String(row?.lowStockThreshold ?? 0),
    },
  })
  const [error, setError] = useState<string | null>(null)
  const [suggesting, setSuggesting] = useState(false)

  const suggest = async () => {
    const name = String(form.getValues('name') ?? '')
    setSuggesting(true)
    const res = await suggestSkuAction(name)
    setSuggesting(false)
    if (res.ok) form.setValue('sku', res.data, { shouldDirty: true, shouldValidate: true })
    else setError(res.error)
  }

  const submit = form.handleSubmit(async (values) => {
    setError(null)
    // The server re-validates everything and takes company/user from the session, never from this payload.
    const res = row ? await updateProductAction(row.id, values) : await createProductAction(values)
    if (!res.ok) return setError(applyActionErrors(form, res))
    onHide()
  })

  return (
    <Modal show onHide={onHide} centered size="lg" backdrop="static">
      <form onSubmit={submit} noValidate>
        <Modal.Header closeButton>
          <Modal.Title as="h5">{row ? 'Edit product' : 'New product'}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {error && <Alert variant="danger">{error}</Alert>}
          <FormProvider {...form}>
            <Row>
              <Col md={7}>
                <FormField name="name" label="Product name" required placeholder="e.g. Samsung Galaxy A15 128GB" />
              </Col>
              <Col md={5}>
                <FormField name="sku" label="SKU" required help="Unique per company. Use Suggest for the next free code." />
                <Button type="button" variant="light" size="sm" className="mt-n2 mb-3" onClick={suggest} disabled={suggesting}>
                  <Icon icon="wand-sparkles" className="me-1" /> {suggesting ? 'Suggesting…' : 'Suggest SKU'}
                </Button>
              </Col>
            </Row>
            <Row>
              <Col md={6}>
                <PickerField name="categoryId" label="Category" loadOptions={searchCategoriesAction} placeholder="Search categories…" initial={row?.categoryId ? { value: row.categoryId, label: row.categoryName ?? '' } : null} />
              </Col>
              <Col md={6}>
                <PickerField name="brandId" label="Brand" loadOptions={searchBrandsAction} placeholder="Search brands…" initial={row?.brandId ? { value: row.brandId, label: row.brandName ?? '' } : null} />
              </Col>
            </Row>
            <Row>
              {showCost && (
                <Col md={6}>
                  <FormField name="purchasePrice" label="Purchase price" placeholder="0.00" help="e.g. 18,500 or 1,25,000.50" />
                </Col>
              )}
              <Col md={6}>
                <FormField name="salePrice" label="Sale price" placeholder="0.00" />
              </Col>
            </Row>
            <Row>
              <Col md={6}>
                <FormField name="warrantyMonths" label="Warranty (months)" type="text" help="0 = no warranty" />
              </Col>
              <Col md={6}>
                <FormField name="lowStockThreshold" label="Low-stock alert at" type="text" help="Dashboard flags stock at or below this" />
              </Col>
            </Row>
            <Row>
              <Col md={6}>
                <FormField name="trackSerial" type="checkbox" label="Track serial / IMEI per unit" help="Cannot be changed once the product has stock." />
              </Col>
            </Row>
          </FormProvider>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="light" onClick={onHide} disabled={form.formState.isSubmitting}>
            Cancel
          </Button>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? 'Saving…' : 'Save product'}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  )
}

/** Category / brand filters kept in the URL (?category=<id>&brand=<id>). */
const Filters = ({ status, category, brand }: Pick<Props, 'status' | 'category' | 'brand'>) => {
  const router = useRouter()
  const pathname = usePathname()
  const sp = useSearchParams()
  const [pending, start] = useTransition()
  const set = (key: 'category' | 'brand', o: SearchOption | null) => {
    const params = new URLSearchParams(sp.toString())
    params.delete('page')
    if (o) params.set(key, o.value)
    else params.delete(key)
    const qs = params.toString()
    start(() => router.push(qs ? `${pathname}?${qs}` : pathname))
  }
  return (
    <div className="d-flex flex-wrap gap-2 align-items-start mb-3" style={{ opacity: pending ? 0.6 : 1 }}>
      <div style={{ minWidth: 220 }}>
        <SearchSelect loadOptions={searchCategoriesAction} value={category} onChange={(o) => set('category', o)} placeholder="All categories" />
      </div>
      <div style={{ minWidth: 220 }}>
        <SearchSelect loadOptions={searchBrandsAction} value={brand} onChange={(o) => set('brand', o)} placeholder="All brands" />
      </div>
      <StatusFilter value={status} />
    </div>
  )
}

const ProductList = ({ rows, total, page, pageSize, q, status, category, brand, can, showCost }: Props) => {
  const [editing, setEditing] = useState<ProductListRow | 'new' | null>(null)
  const [rowError, setRowError] = useState<string | null>(null)

  const columnDefs = useMemo(
    () =>
      [
        {
          id: 'name',
          header: 'Product',
          accessorKey: 'name',
          enableSorting: false,
          cell: ({ row }) => (
            <div>
              <Link href={`/products/${row.original.id}`} className="fw-semibold">
                {row.original.name}
              </Link>
              <small className="text-muted d-block">
                {row.original.sku}
                {row.original.trackSerial && (
                  <Badge bg="info-subtle" text="info" className="ms-2">
                    Serial
                  </Badge>
                )}
              </small>
            </div>
          ),
        },
        { id: 'category', header: 'Category', accessorFn: (r) => r.categoryName ?? '-', enableSorting: false },
        { id: 'brand', header: 'Brand', accessorFn: (r) => r.brandName ?? '-', enableSorting: false },
        ...(showCost ? [{ id: 'purchasePrice', header: 'Purchase', accessorKey: 'purchasePrice', enableSorting: false, meta: { align: 'end' }, cell: ({ getValue }) => <MoneyText value={getValue() as string} /> } as ColumnDef<ProductListRow, never>] : []),
        { id: 'salePrice', header: 'Sale', accessorKey: 'salePrice', enableSorting: false, meta: { align: 'end' }, cell: ({ getValue }) => <MoneyText value={getValue() as string} /> },
        { id: 'warranty', header: 'Warranty', accessorFn: (r) => (r.warrantyMonths ? `${r.warrantyMonths} mo` : '-'), enableSorting: false },
        {
          id: 'active',
          header: 'Status',
          accessorKey: 'active',
          enableSorting: false,
          cell: ({ row }) => (row.original.active ? <Badge bg="success-subtle" text="success">Active</Badge> : <Badge bg="secondary-subtle" text="secondary">Inactive</Badge>),
        },
        {
          id: 'actions',
          header: '',
          enableSorting: false,
          cell: ({ row }) => {
            const r = row.original
            return (
              <div className="d-flex gap-1 justify-content-end">
                <HistoryButton entity="product" id={r.id} title={r.name} size="sm" iconOnly />
                {can.edit && (
                  <Button size="sm" variant="tonal-primary" className="btn-square" aria-label={`Edit ${r.name}`} onClick={() => setEditing(r)}>
                    <Icon icon="pencil" />
                  </Button>
                )}
                {r.active && can.delete && (
                  <ConfirmDelete itemName={r.name} title="Deactivate this product?" message="It will be hidden from lists and new documents. History is kept and you can restore it later." confirmLabel="Deactivate" onConfirm={async () => toConfirmResult(await deactivateProductAction(r.id))} />
                )}
                {!r.active && can.edit && (
                  <Button
                    size="sm"
                    variant="tonal-success"
                    onClick={async () => {
                      setRowError(null)
                      const res = await activateProductAction(r.id)
                      if (!res.ok) setRowError(res.error)
                    }}
                  >
                    Restore
                  </Button>
                )}
              </div>
            )
          },
        },
      ] as ColumnDef<ProductListRow, never>[],
    [can.edit, can.delete, showCost],
  )

  return (
    <>
      {rowError && (
        <Alert variant="danger" dismissible onClose={() => setRowError(null)}>
          {rowError}
        </Alert>
      )}
      <Filters status={status} category={category} brand={brand} />
      <PaginatedTable
        rows={rows}
        total={total}
        page={page}
        pageSize={pageSize}
        q={q}
        columnDefs={columnDefs}
        searchPlaceholder="Search name or SKU…"
        itemsName="products"
        emptyTitle="No products yet"
        emptyDescription={can.create ? 'Add your first product to start purchasing and selling.' : undefined}
        toolbar={
          can.create ? (
            <Button onClick={() => setEditing('new')}>
              <Icon icon="plus" className="me-1" /> Add product
            </Button>
          ) : undefined
        }
      />
      {editing && <ProductModal row={editing === 'new' ? null : editing} onHide={() => setEditing(null)} showCost={showCost} />}
    </>
  )
}

export default ProductList
