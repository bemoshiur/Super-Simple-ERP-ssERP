import PageBreadcrumb from '@/components/PageBreadcrumb'
import NoAccess from '@/components/ui/NoAccess'
import { getSession } from '@/server/auth/current'
import { listProducts } from '@/server/catalog/products'
import { getDb, schema } from '@/server/db'
import { parseListParams, type RawSearchParams } from '@/server/pagination'
import { can } from '@/server/rbac'
import { canSeeProfit } from '@/server/lookup/lookup'
import { productRowsForClient } from '@/server/catalog/visibility'
import { and, eq } from 'drizzle-orm'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { Card, CardBody } from 'react-bootstrap'
import ProductList from './ProductList'

export const metadata: Metadata = { title: 'Products' }

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export default async function Page({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const session = await getSession()
  if (!session) redirect('/auth/login')
  if (!can(session, 'products.view')) return (<><PageBreadcrumb title="Products" subtitle="Inventory" /><NoAccess /></>)

  const sp = await searchParams
  const { q, page, pageSize, offset } = parseListParams(sp)
  const rawStatus = one(sp.status)
  const status = rawStatus === 'inactive' || rawStatus === 'all' ? rawStatus : 'active'
  const catId = z.uuid().safeParse(one(sp.category)).data
  const brandId = z.uuid().safeParse(one(sp.brand)).data

  const db = getDb()
  const [{ rows, total }, category, brand] = await Promise.all([
    listProducts(db, session.cid, { q, status, categoryId: catId, brandId, limit: pageSize, offset }),
    catId ? db.select({ id: schema.categories.id, name: schema.categories.name }).from(schema.categories).where(and(eq(schema.categories.id, catId), eq(schema.categories.companyId, session.cid))) : [],
    brandId ? db.select({ id: schema.brands.id, name: schema.brands.name }).from(schema.brands).where(and(eq(schema.brands.id, brandId), eq(schema.brands.companyId, session.cid))) : [],
  ])

  // The list purchase price is cost information: it never reaches the client without profit visibility.
  const showCost = canSeeProfit(session)
  const safeRows = productRowsForClient(rows, showCost)

  return (
    <>
      <PageBreadcrumb title="Products" subtitle="Inventory" />
      <Card>
        <CardBody>
          <ProductList
            rows={safeRows}
            showCost={showCost}
            total={total}
            page={page}
            pageSize={pageSize}
            q={q}
            status={status}
            category={category[0] ? { value: category[0].id, label: category[0].name } : null}
            brand={brand[0] ? { value: brand[0].id, label: brand[0].name } : null}
            can={{ create: can(session, 'products.create'), edit: can(session, 'products.edit'), delete: can(session, 'products.delete') }}
          />
        </CardBody>
      </Card>
    </>
  )
}
