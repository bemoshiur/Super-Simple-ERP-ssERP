'use client'
import FormModal, { PlusLabel } from '@/components/ui/FormModal'
import Icon from '@/components/wrappers/Icon'
import { createExpenseAction, createIncomeAction, updateExpenseAction, updateIncomeAction, voidExpenseAction, voidIncomeAction } from '@/server/actions/accounting'

type Opt = { value: string; label: string }

/** Add expense / add income button (the tab decides which). Needs accounts.create. */
export const EntryToolbar = ({ kind, accounts, categories, suggestions, today }: { kind: 'expense' | 'income'; accounts: Opt[]; categories: Opt[]; suggestions: string[]; today: string }) => (
  <FormModal
    trigger={<PlusLabel>{kind === 'expense' ? 'Add expense' : 'Add income'}</PlusLabel>}
    title={kind === 'expense' ? 'Add expense' : 'Add other income'}
    intro={kind === 'expense' ? 'Money paid out of an account for running costs (rent, salary, bills). Purchases of stock are recorded under Purchases, not here.' : 'Money received that is not a sale (interest, rebates, refunds from suppliers outside invoices).'}
    fields={[
      kind === 'expense' ? { name: 'categoryId', label: 'Category', type: 'select', placeholder: 'No category', options: categories, col: 6 } : { name: 'category', label: 'Category', suggestions, maxLength: 80, col: 6, help: 'Type a new one or pick an earlier one.' },
      { name: 'accountId', label: kind === 'expense' ? 'Paid from' : 'Received into', type: 'select', placeholder: 'Choose account…', options: accounts, col: 6 },
      { name: 'amount', label: 'Amount', type: 'money', col: 6 },
      { name: 'date', label: 'Date', type: 'date', col: 6 },
      { name: 'note', label: 'Note', type: 'textarea', maxLength: 500 },
    ]}
    initial={{ categoryId: '', category: '', accountId: accounts[0]?.value ?? '', amount: '', date: today, note: '' }}
    onSubmit={(v) => (kind === 'expense' ? createExpenseAction(v) : createIncomeAction(v))}
  />
)

/** Edit (category/note only, accounts.edit) and void (accounts.delete) for one active entry. */
export const EntryRowActions = ({ kind, row, categories, suggestions, can }: { kind: 'expense' | 'income'; row: { id: string; note: string; categoryId: string; category: string }; categories: Opt[]; suggestions: string[]; can: { edit: boolean; delete: boolean } }) => (
  <>
    {can.edit && (
      <FormModal
        trigger={<Icon icon="pencil" />}
        triggerVariant="tonal-secondary"
        triggerSize="sm"
        triggerClassName="btn-square me-1"
        triggerLabel="Edit entry"
        title="Edit entry"
        intro="Only the category and note can change. To correct the amount, date or account, void this entry and enter it again."
        fields={[
          kind === 'expense' ? { name: 'categoryId', label: 'Category', type: 'select', placeholder: 'No category', options: categories } : { name: 'category', label: 'Category', suggestions, maxLength: 80 },
          { name: 'note', label: 'Note', type: 'textarea', maxLength: 500 },
        ]}
        initial={{ categoryId: row.categoryId, category: row.category, note: row.note }}
        onSubmit={(v) => (kind === 'expense' ? updateExpenseAction(row.id, v) : updateIncomeAction(row.id, v))}
      />
    )}
    {can.delete && (
      <FormModal
        trigger={<Icon icon="ban" />}
        triggerVariant="tonal-danger"
        triggerSize="sm"
        triggerClassName="btn-square"
        triggerLabel="Void entry"
        title="Void this entry?"
        intro="The entry is kept for the record, a reversing payment is posted today so the account balance is corrected, and it no longer counts in the profit & loss."
        submitLabel="Void entry"
        submitVariant="danger"
        fields={[{ name: 'reason', label: 'Reason', maxLength: 200 }]}
        initial={{ reason: '' }}
        onSubmit={(v) => (kind === 'expense' ? voidExpenseAction(row.id, v) : voidIncomeAction(row.id, v))}
      />
    )}
  </>
)
