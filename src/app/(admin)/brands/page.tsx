import type { Metadata } from 'next'
import type { RawSearchParams } from '@/server/pagination'
import TaxonPage from '../_taxa/TaxonPage'

export const metadata: Metadata = { title: 'Brands' }

export default async function Page({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  return <TaxonPage kind="brand" sp={await searchParams} />
}
