import type { Metadata } from 'next'
import type { RawSearchParams } from '@/server/pagination'
import TaxonPage from '../_taxa/TaxonPage'

export const metadata: Metadata = { title: 'Categories' }

export default async function Page({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  return <TaxonPage kind="category" sp={await searchParams} />
}
