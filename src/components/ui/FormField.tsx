'use client'
import { zodResolver } from '@hookform/resolvers/zod'
import get from 'lodash/get'
import type { ReactNode } from 'react'
import { Form } from 'react-bootstrap'
import { FormProvider, useForm, useFormContext, type DefaultValues, type FieldValues, type UseFormProps } from 'react-hook-form'
import type { z } from 'zod'

export { FormProvider, useFormContext }

/** react-hook-form wired to a zod schema. Input type = what the user types; output = parsed values passed to handleSubmit. */
export function useZodForm<S extends z.ZodType<FieldValues, FieldValues>>(schema: S, options: Omit<UseFormProps<z.input<S>, unknown, z.output<S>>, 'resolver' | 'defaultValues'> & { defaultValues?: DefaultValues<z.input<S>> } = {}) {
  return useForm<z.input<S>, unknown, z.output<S>>({ ...options, resolver: zodResolver(schema) as never })
}

export type SelectOption = { value: string; label: string }

type Props = {
  name: string
  label: ReactNode
  type?: 'text' | 'email' | 'password' | 'number' | 'date' | 'tel' | 'textarea' | 'select' | 'checkbox'
  options?: SelectOption[]
  placeholder?: string
  help?: ReactNode
  required?: boolean
  disabled?: boolean
  rows?: number
  step?: string
  autoComplete?: string
  className?: string
}

/**
 * Labelled input bound to the surrounding <FormProvider>/useZodForm() form: shows the zod error under the
 * field. Number inputs register as strings: keep money fields as text/number strings and let the zod schema
 * parse them (e.g. with toMinor), never `valueAsNumber`.
 */
const FormField = ({ name, label, type = 'text', options = [], placeholder, help, required, disabled, rows = 3, step, autoComplete, className = 'mb-3' }: Props) => {
  const {
    register,
    formState: { errors },
  } = useFormContext()
  const error = get(errors, name) as { message?: unknown } | undefined
  const message = typeof error?.message === 'string' ? error.message : undefined
  const id = `field-${name.replace(/[^a-zA-Z0-9_-]/g, '-')}`
  const common = { id, disabled, isInvalid: !!error, 'aria-describedby': message ? `${id}-error` : help ? `${id}-help` : undefined } as const

  const feedback = message ? (
    <Form.Control.Feedback type="invalid" id={`${id}-error`} style={{ display: 'block' }}>
      {message}
    </Form.Control.Feedback>
  ) : help ? (
    <Form.Text id={`${id}-help`} className="text-muted">
      {help}
    </Form.Text>
  ) : null

  if (type === 'checkbox') {
    return (
      <Form.Group className={className}>
        <Form.Check type="checkbox" label={label} {...common} {...register(name)} />
        {feedback}
      </Form.Group>
    )
  }

  return (
    <Form.Group className={className} controlId={id}>
      <Form.Label>
        {label} {required && <span className="text-danger">*</span>}
      </Form.Label>
      {type === 'textarea' ? (
        <Form.Control as="textarea" rows={rows} placeholder={placeholder} {...common} {...register(name)} />
      ) : type === 'select' ? (
        <Form.Select {...common} {...register(name)}>
          {placeholder !== undefined && <option value="">{placeholder}</option>}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Form.Select>
      ) : (
        <Form.Control type={type} placeholder={placeholder} step={step} autoComplete={autoComplete} inputMode={type === 'number' ? 'decimal' : undefined} {...common} {...register(name)} />
      )}
      {feedback}
    </Form.Group>
  )
}

export default FormField
