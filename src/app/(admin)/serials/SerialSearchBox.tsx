'use client'
import BarcodeScanButton from '@/components/scan/BarcodeScanButton'
import Icon from '@/components/wrappers/Icon'
import { normalizeSearchTerm } from '@/server/lookup/pure'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState, useTransition } from 'react'
import { Button, Form, InputGroup } from 'react-bootstrap'

/** Scan-first search: autofocus, Enter submits, pasted/scanned text is cleaned (BOM, zero-width, whitespace) first. */
const SerialSearchBox = ({ initial }: { initial: string }) => {
  const router = useRouter()
  const ref = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(initial)
  const [pending, start] = useTransition()
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [initial])
  const submit = (raw?: string) => {
    const q = normalizeSearchTerm(raw ?? value)
    setValue(q)
    if (!q) return ref.current?.focus()
    start(() => router.push(`/serials?q=${encodeURIComponent(q)}`))
  }
  return (
    <Form
      role="search"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <InputGroup size="lg">
        <InputGroup.Text>
          <Icon icon="scan-barcode" />
        </InputGroup.Text>
        <Form.Control
          ref={ref}
          autoFocus
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          inputMode="text"
          aria-label="Serial or IMEI"
          placeholder="Scan or type a serial / IMEI, then press Enter"
          className="font-monospace"
          value={value}
          maxLength={200}
          onChange={(e) => setValue(e.target.value)}
          onPaste={(e) => {
            // Clean pasted text immediately so the box shows exactly what will be searched.
            const text = e.clipboardData.getData('text')
            if (!text) return
            e.preventDefault()
            setValue(normalizeSearchTerm(text))
          }}
        />
        <BarcodeScanButton size="lg" label="" title="Scan a serial with the camera" onScan={(code) => submit(code)} />
        <Button type="submit" disabled={pending}>
          {pending ? 'Searching…' : 'Look up'}
        </Button>
      </InputGroup>
    </Form>
  )
}

export default SerialSearchBox
