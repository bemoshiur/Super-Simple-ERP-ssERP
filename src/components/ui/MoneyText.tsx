import { fmt, fmtBD } from '@/server/money'
import clsx from 'clsx'

type Props = {
  /** numeric(14,2) string (preferred) or number. null/undefined renders a dash. */
  value: string | number | null | undefined
  /** Currency symbol; defaults to the taka sign. Pass the company's `currency_symbol` setting when you have it. */
  symbol?: string
  /** 'bd' = lakh/crore grouping (12,34,567.50), 'western' = 1,234,567.50. */
  grouping?: 'bd' | 'western'
  /** Colour negatives red (and positives green when `signed`). */
  tone?: boolean
  className?: string
}

/** Formats money for display only; never do arithmetic on the rendered text. Safe in server and client components. */
const MoneyText = ({ value, symbol, grouping = 'bd', tone = false, className }: Props) => {
  if (value === null || value === undefined || value === '') return <span className={clsx('text-muted', className)}>-</span>
  let text: string
  let negative = false
  try {
    text = (grouping === 'bd' ? fmtBD : fmt)(value, symbol)
    negative = text.startsWith('-')
  } catch {
    return <span className={clsx('text-danger', className)}>invalid</span>
  }
  return <span className={clsx('text-nowrap', tone && negative && 'text-danger', className)}>{text}</span>
}

export default MoneyText
