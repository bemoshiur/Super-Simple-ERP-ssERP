'use client'
import get from 'lodash/get'
import { useState } from 'react'
import { Form } from 'react-bootstrap'
import { useFormContext } from 'react-hook-form'
import SearchSelect, { type SearchOption } from './SearchSelect'

type Props = {
  name: string
  label: string
  loadOptions: (q: string) => Promise<SearchOption[]>
  /** Currently selected option when editing (id + display label). */
  initial?: SearchOption | null
  placeholder?: string
}

/** A SearchSelect bound to a react-hook-form field holding the selected id ('' = none). */
const PickerField = ({ name, label, loadOptions, initial = null, placeholder }: Props) => {
  const {
    setValue,
    formState: { errors },
  } = useFormContext()
  const [selected, setSelected] = useState<SearchOption | null>(initial)
  const error = get(errors, name) as { message?: unknown } | undefined
  const message = typeof error?.message === 'string' ? error.message : undefined
  return (
    <Form.Group className="mb-3">
      <Form.Label htmlFor={`pick-${name}`}>{label}</Form.Label>
      <SearchSelect
        id={`pick-${name}`}
        loadOptions={loadOptions}
        value={selected}
        placeholder={placeholder}
        invalid={!!message}
        onChange={(o) => {
          setSelected(o)
          setValue(name, o?.value ?? '', { shouldDirty: true, shouldValidate: true })
        }}
      />
      {message && <div className="invalid-feedback d-block">{message}</div>}
    </Form.Group>
  )
}

export default PickerField
