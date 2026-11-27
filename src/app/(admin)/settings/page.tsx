import PageBreadcrumb from '@/components/PageBreadcrumb'
import HistoryButton from '@/components/ui/HistoryButton'
import NoAccess from '@/components/ui/NoAccess'
import { getSession } from '@/server/auth/current'
import { appTimezone } from '@/server/dates'
import { getDb } from '@/server/db'
import { WEEK_START } from '@/server/reports/pure'
import { getSettings } from '@/server/settings/settings'
import { can } from '@/server/rbac'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import SettingsForm from './SettingsForm'

export const metadata: Metadata = { title: 'Settings' }

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export default async function Page() {
  const session = await getSession()
  if (!session) redirect('/auth/login')
  if (!can(session, 'settings.view')) return (<><PageBreadcrumb title="Settings" subtitle="Administration" /><NoAccess /></>)
  const s = await getSettings(getDb(), session.cid)
  const str = (v: string | null) => v ?? ''
  return (
    <>
      <PageBreadcrumb title="Settings" subtitle="Administration" />
      <div className="d-flex justify-content-end mb-2">
        <HistoryButton entity="settings" id={session.cid} title="Settings" />
      </div>
      <SettingsForm
        initial={{
          companyName: s.companyName,
          companyAddress: str(s.companyAddress),
          companyPhone: str(s.companyPhone),
          companyEmail: str(s.companyEmail),
          currencySymbol: str(s.currencySymbol),
          invoiceFooter: str(s.invoiceFooter),
          logoUrl: str(s.logoUrl),
          prefixSale: str(s.prefixSale),
          prefixPurchase: str(s.prefixPurchase),
          prefixSaleReturn: str(s.prefixSaleReturn),
          prefixPurchaseReturn: str(s.prefixPurchaseReturn),
          prefixService: str(s.prefixService),
        }}
        timezone={appTimezone()}
        weekStart={DAYS[WEEK_START]}
        canEdit={can(session, 'settings.edit')}
      />
    </>
  )
}
