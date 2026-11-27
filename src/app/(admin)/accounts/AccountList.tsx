'use client'
import ConfirmDelete from '@/components/ui/ConfirmDelete'
import EmptyState from '@/components/ui/EmptyState'
import FormModal, { PlusLabel } from '@/components/ui/FormModal'
import MoneyText from '@/components/ui/MoneyText'
import StatusFilter from '@/components/ui/StatusFilter'
import Icon from '@/components/wrappers/Icon'
import { toConfirmResult } from '@/components/ui/actionUi'
import { activateAccountAction, createAccountAction, createTransferAction, deactivateAccountAction, updateAccountAction } from '@/server/actions/accounting'
import type { AccountBalance } from '@/server/accounting/accounts'
import { toMinor } from '@/server/money'
import Link from 'next/link'
import { Badge, Button, Table } from 'react-bootstrap'

const TYPES = [
  { value: 'cash', label: 'Cash' },
  { value: 'bank', label: 'Bank' },
  { value: 'mobile', label: 'Mobile wallet' },
]
const TYPE_LABEL: Record<string, string> = { cash: 'Cash', bank: 'Bank', mobile: 'Mobile' }

const AccountList = ({ rows, total, status, transferTargets, today, can }: { rows: AccountBalance[]; total: string; status: 'active' | 'inactive' | 'all'; transferTargets: { value: string; label: string }[]; today: string; can: { create: boolean; edit: boolean; delete: boolean } }) => (
  <>
    <div className="d-flex flex-wrap gap-2 justify-content-between align-items-center mb-3">
      <StatusFilter value={status} />
      <div className="d-flex gap-2">
        {can.create && transferTargets.length >= 2 && (
          <FormModal
            trigger={<><Icon icon="arrow-left-right" className="me-1" /> Transfer</>}
            triggerVariant="light"
            title="Transfer between accounts"
            intro="Moves money out of one account and into another. Both entries are recorded as payments, so balances and reports stay in step."
            submitLabel="Transfer"
            fields={[
              { name: 'fromAccountId', label: 'From', type: 'select', placeholder: 'Choose account…', options: transferTargets, col: 6 },
              { name: 'toAccountId', label: 'To', type: 'select', placeholder: 'Choose account…', options: transferTargets, col: 6 },
              { name: 'amount', label: 'Amount', type: 'money', col: 6 },
              { name: 'date', label: 'Date', type: 'date', col: 6 },
              { name: 'note', label: 'Note', maxLength: 500 },
            ]}
            initial={{ fromAccountId: '', toAccountId: '', amount: '', date: today, note: '' }}
            onSubmit={(v) => createTransferAction(v)}
          />
        )}
        {can.create && (
          <FormModal
            trigger={<PlusLabel>New account</PlusLabel>}
            title="New account"
            fields={[
              { name: 'name', label: 'Name', maxLength: 100 },
              { name: 'type', label: 'Type', type: 'select', options: TYPES, col: 6 },
              { name: 'openingBalance', label: 'Opening balance', type: 'money', col: 6, help: 'Money already in the account when you start. May be negative.' },
            ]}
            initial={{ name: '', type: 'cash', openingBalance: '0.00' }}
            onSubmit={(v) => createAccountAction(v)}
          />
        )}
      </div>
    </div>

    {rows.length === 0 ? (
      <EmptyState icon="landmark" title="No accounts" description="Add a cash, bank or mobile-wallet account to record payments." />
    ) : (
      <div className="table-responsive">
        <Table hover className="align-middle mb-0">
          <thead>
            <tr>
              <th>Account</th>
              <th>Type</th>
              <th className="text-end">Opening</th>
              <th className="text-end">Money in</th>
              <th className="text-end">Money out</th>
              <th className="text-end">Balance</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id} className={a.active ? undefined : 'text-muted'}>
                <td>
                  <Link href={`/payments?account=${a.id}`} className="fw-semibold">
                    {a.name}
                  </Link>{' '}
                  {!a.active && <Badge bg="secondary">Inactive</Badge>} {toMinor(a.balance) < 0 && <Badge bg="warning" text="dark" title="This account holds less than zero. Check for a missing deposit or transfer.">Overdrawn</Badge>}
                </td>
                <td>{TYPE_LABEL[a.type]}</td>
                <td className="text-end"><MoneyText value={a.opening} /></td>
                <td className="text-end"><MoneyText value={a.totalIn} /></td>
                <td className="text-end"><MoneyText value={a.totalOut} /></td>
                <td className="text-end fw-semibold"><MoneyText value={a.balance} tone /></td>
                <td className="text-end text-nowrap">
                  {can.edit && (
                    <FormModal
                      trigger={<Icon icon="pencil" />}
                      triggerVariant="tonal-secondary"
                      triggerSize="sm"
                      triggerClassName="btn-square me-1"
                      triggerLabel={`Edit ${a.name}`}
                      title={`Edit ${a.name}`}
                      intro="Changing the opening balance changes the balance by the same amount."
                      fields={[
                        { name: 'name', label: 'Name', maxLength: 100 },
                        { name: 'type', label: 'Type', type: 'select', options: TYPES, col: 6 },
                        { name: 'openingBalance', label: 'Opening balance', type: 'money', col: 6 },
                      ]}
                      initial={{ name: a.name, type: a.type, openingBalance: a.opening }}
                      onSubmit={(v) => updateAccountAction(a.id, v)}
                    />
                  )}
                  {a.active
                    ? can.delete && (
                        <ConfirmDelete
                          title="Deactivate this account?"
                          itemName={a.name}
                          message="The account stays in your history but can no longer be chosen for new payments. It must hold a zero balance."
                          confirmLabel="Deactivate"
                          onConfirm={async () => toConfirmResult(await deactivateAccountAction(a.id))}
                        />
                      )
                    : can.edit && (
                        <Button size="sm" variant="tonal-success" onClick={async () => void (await activateAccountAction(a.id))} className="ms-1">
                          Reactivate
                        </Button>
                      )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="fw-semibold">
              <td colSpan={5} className="text-end">
                Total of the accounts shown
              </td>
              <td className="text-end"><MoneyText value={total} tone /></td>
              <td />
            </tr>
          </tfoot>
        </Table>
      </div>
    )}
  </>
)

export default AccountList
