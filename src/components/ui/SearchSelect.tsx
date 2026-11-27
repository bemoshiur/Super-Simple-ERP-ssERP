'use client'
import Icon from '@/components/wrappers/Icon'
import { useCallback, useEffect, useId, useRef, useState } from 'react'

export type SearchOption = { value: string; label: string; description?: string }

type Props = {
  /** Fetch options for the typed text. Typically a server action or a fetch to a company-scoped route; results must be authorised server-side. */
  loadOptions: (query: string) => Promise<SearchOption[]>
  value: SearchOption | null
  onChange: (option: SearchOption | null) => void
  placeholder?: string
  /** Wait this long after the last keystroke before searching. */
  debounceMs?: number
  /** Minimum characters before searching (0 = list on focus). */
  minChars?: number
  disabled?: boolean
  invalid?: boolean
  id?: string
  /** Accessible name when there is no <label htmlFor={id}> (e.g. inside a table row). */
  ariaLabel?: string
  className?: string
}

/** Async, keyboard-accessible single select (combobox). Stale responses are ignored; errors show inline. */
const SearchSelect = ({ loadOptions, value, onChange, placeholder = 'Search…', debounceMs = 250, minChars = 0, disabled, invalid, id, ariaLabel, className }: Props) => {
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  const [options, setOptions] = useState<SearchOption[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const seq = useRef(0)
  const listId = useId()
  const tooShort = text.trim().length < minChars

  const search = useCallback(
    async (q: string) => {
      const mine = ++seq.current
      setLoading(true)
      setError(false)
      try {
        const res = await loadOptions(q)
        if (mine !== seq.current) return // a newer search superseded this one
        setOptions(res)
        setActive(0)
      } catch {
        if (mine === seq.current) {
          setOptions([])
          setError(true)
        }
      } finally {
        if (mine === seq.current) setLoading(false)
      }
    },
    [loadOptions],
  )

  useEffect(() => {
    if (!open || tooShort) return
    const t = setTimeout(() => void search(text.trim()), debounceMs)
    return () => clearTimeout(t)
  }, [text, open, tooShort, debounceMs, search])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const pick = (o: SearchOption) => {
    onChange(o)
    setText('')
    setOpen(false)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      setActive((i) => Math.min(i + 1, Math.max(options.length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && open && options[active]) {
      e.preventDefault()
      pick(options[active])
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div ref={root} className={`position-relative ${className ?? ''}`}>
      <div className="input-group">
        <input
          id={id}
          aria-label={ariaLabel}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          className={`form-control ${invalid ? 'is-invalid' : ''}`}
          placeholder={value ? value.label : placeholder}
          value={text}
          disabled={disabled}
          autoComplete="off"
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setText(e.target.value)
            setOpen(true)
          }}
          onKeyDown={onKeyDown}
        />
        {value && !disabled && (
          <button type="button" className="btn btn-light" aria-label="Clear selection" onClick={() => onChange(null)}>
            <Icon icon="x" />
          </button>
        )}
      </div>
      {value && !text && (
        <div className="small text-muted mt-1" style={{ overflowWrap: 'anywhere' }}>
          Selected: <span className="fw-semibold">{value.label}</span>
        </div>
      )}
      {open && (
        <ul id={listId} role="listbox" className="list-group position-absolute w-100 shadow-sm mt-1" style={{ zIndex: 1055, maxHeight: 260, overflowY: 'auto' }}>
          {!tooShort && loading && <li className="list-group-item text-muted small">Searching…</li>}
          {!tooShort && !loading && error && <li className="list-group-item text-danger small">Could not load results. Try again.</li>}
          {tooShort && <li className="list-group-item text-muted small">Type at least {minChars} characters</li>}
          {!tooShort && !loading && !error && options.length === 0 && <li className="list-group-item text-muted small">No matches</li>}
          {!tooShort && options.map((o, i) => (
            <li key={o.value} role="option" aria-selected={value?.value === o.value} className={`list-group-item list-group-item-action ${i === active ? 'active' : ''}`} style={{ cursor: 'pointer' }} onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(o)}>
              <div>{o.label}</div>
              {o.description && <small className={i === active ? '' : 'text-muted'}>{o.description}</small>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default SearchSelect
