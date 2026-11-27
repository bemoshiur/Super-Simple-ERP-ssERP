import type { RawSearchParams } from '@/server/pagination'
import type { Metadata } from 'next'
import PartyPage from '../_parties/PartyPage'

export const metadata: Metadata = { title: 'Vendors' }

export default async function Page({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  return <PartyPage kind="vendor" sp={await searchParams} />
}
