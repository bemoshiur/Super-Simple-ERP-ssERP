import type { Metadata } from 'next'
import PartyDetail from '../../_parties/PartyDetail'

export const metadata: Metadata = { title: 'Vendors' }

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  return <PartyDetail kind="vendor" id={(await params).id} />
}
