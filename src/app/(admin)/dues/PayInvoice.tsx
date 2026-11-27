'use client'
import FormModal from '@/components/ui/FormModal'
import MoneyText from '@/components/ui/MoneyText'
import { recordVendorPaymentAction } from '@/server/actions/purchases'

/** Pay one vendor invoice: calls the existing recordVendorPayment code via its guarded action (purchases.edit). */
const PayInvoice = ({ purchaseId, invoiceNo, due, accounts, today }: { purchaseId: string; invoiceNo: string; due: string; accounts: { id: string; name: string; type: string }[]; today: string }) => (
  <FormModal
    trigger="Pay"
    triggerVariant="success"
    triggerSize="sm"
    title={`Pay vendor · ${invoiceNo}`}
    intro={
      <>
        Due on this invoice: <MoneyText value={due} className="fw-semibold" />. Partial payments are fine.
      </>
    }
    fields={[
      { name: 'amount', label: 'Amount', type: 'money', col: 6 },
      { name: 'date', label: 'Date', type: 'date', col: 6 },
      { name: 'accountId', label: 'Paid from', type: 'select', placeholder: 'Choose account…', options: accounts.map((a) => ({ value: a.id, label: a.name })), col: 6 },
      { name: 'method', label: 'Method / reference', maxLength: 50, col: 6 },
      { name: 'note', label: 'Note', maxLength: 500 },
    ]}
    initial={{ amount: due, date: today, accountId: accounts.find((a) => a.type === 'cash')?.id ?? '', method: '', note: '' }}
    submitLabel="Record payment"
    onSubmit={(v) => recordVendorPaymentAction(purchaseId, v)}
  />
)

export default PayInvoice
