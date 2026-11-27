/**
 * Money helpers. Money is stored as numeric(14,2) strings in Postgres and handled
 * in JS as integer minor units (paisa/cents). Never use float arithmetic on money.
 */

export const DEFAULT_CURRENCY_SYMBOL = '৳'

/** Parse a decimal string to minor units (2 dp), rounding half away from zero. */
function parseDecimalToMinor(input: string): number {
  let s = input.trim()
  if (s.includes(',')) {
    // Commas are only valid as digit-group separators, in one of two strict layouts:
    //   western  1,234,567.50  (groups of 3)
    //   lakh     12,34,567.50  (last group of 3, preceding groups of 2, leading group 1-2 digits)
    const western = /^[+-]?\d{1,3}(,\d{3})+(\.\d*)?$/
    const lakh = /^[+-]?\d{1,2}(,\d{2})*,\d{3}(\.\d*)?$/
    if (!western.test(s) && !lakh.test(s)) throw new Error(`Invalid money value: "${input}"`)
    s = s.replace(/,/g, '')
  }
  const m = /^([+-])?(\d*)(?:\.(\d*))?$/.exec(s)
  if (!m || (m[2] === '' && (m[3] === undefined || m[3] === ''))) {
    throw new Error(`Invalid money value: "${input}"`)
  }
  const negative = m[1] === '-'
  const whole = m[2] || '0'
  const frac = m[3] ?? ''
  const cents = Number(whole + (frac + '00').slice(0, 2))
  const roundUp = frac.length > 2 && frac.charCodeAt(2) >= 53 // digit >= '5'
  const minor = cents + (roundUp ? 1 : 0)
  if (!Number.isSafeInteger(minor)) throw new Error(`Money value out of range: "${input}"`)
  return negative && minor !== 0 ? -minor : minor
}

/** Convert a decimal amount (string or number) to integer minor units. */
export function toMinor(value: string | number): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Invalid money value: not finite')
    // Use the shortest decimal representation so 1.005 -> "1.005" -> 101, not float 100.49999.
    const str = Math.abs(value) < 1e21 && !/e/i.test(String(value)) ? String(value) : value.toFixed(10)
    return parseDecimalToMinor(str)
  }
  return parseDecimalToMinor(value)
}

/** Convert integer minor units to a numeric(14,2) string, e.g. 30 -> "0.30". */
export function fromMinor(minor: number): string {
  if (!Number.isInteger(minor)) throw new Error('fromMinor expects an integer')
  const neg = minor < 0
  const abs = Math.abs(minor)
  const whole = Math.floor(abs / 100)
  const frac = String(abs % 100).padStart(2, '0')
  return `${neg ? '-' : ''}${whole}.${frac}`
}

/** Sum decimal amounts exactly; returns a numeric(14,2) string. */
export function sum(values: Array<string | number>): string {
  return fromMinor(values.reduce<number>((acc, v) => acc + toMinor(v), 0))
}

/** Multiply a unit price by an integer quantity exactly. */
export function mul(unit: string | number, qty: number): string {
  if (!Number.isInteger(qty)) throw new Error('qty must be an integer')
  return fromMinor(toMinor(unit) * qty)
}

/** Format for display: "৳1,234.50". Symbol is configurable via settings. */
export function fmt(value: string | number, symbol: string = DEFAULT_CURRENCY_SYMBOL): string {
  const minor = toMinor(value)
  const neg = minor < 0
  const abs = Math.abs(minor)
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const frac = String(abs % 100).padStart(2, '0')
  return `${neg ? '-' : ''}${symbol}${whole}.${frac}`
}

/** Format with Bangladeshi (lakh/crore) digit grouping: "৳12,34,567.50". Accepts minor-unit-safe strings/numbers. */
export function fmtBD(value: string | number, symbol: string = DEFAULT_CURRENCY_SYMBOL): string {
  const minor = toMinor(value)
  const neg = minor < 0
  const abs = Math.abs(minor)
  const w = Math.floor(abs / 100).toString()
  const whole = w.length <= 3 ? w : w.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + w.slice(-3)
  const frac = String(abs % 100).padStart(2, '0')
  return `${neg ? '-' : ''}${symbol}${whole}.${frac}`
}
