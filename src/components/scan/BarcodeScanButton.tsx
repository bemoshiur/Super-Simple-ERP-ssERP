'use client'
import Icon from '@/components/wrappers/Icon'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button, Modal } from 'react-bootstrap'
import { createDebouncer, normalizeScan } from './scanLogic'
import { useBarcodeScanner } from './useBarcodeScanner'

type ScanResult = boolean | void

export type BarcodeScanButtonProps = {
  /**
   * Called with each accepted, cleaned code. Return `false` to say "not accepted" (e.g. already in the list): the camera
   * stays open and no success beep plays. Anything else counts as accepted.
   */
  onScan: (code: string) => ScanResult | Promise<ScanResult>
  /** Keep scanning after each code (purchase intake). Default: close after the first accepted code. */
  continuous?: boolean
  label?: string
  /** Accessible name / tooltip of the button. */
  title?: string
  size?: 'sm' | 'lg'
  variant?: string
  disabled?: boolean
  className?: string
}

/** One short beep through WebAudio (no audio file). Silently does nothing where audio is blocked. */
function beep(ctx: AudioContext | null, freq = 880, ms = 90) {
  try {
    if (!ctx) return
    if (ctx.state === 'suspended') void ctx.resume()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.frequency.value = freq
    gain.gain.value = 0.08
    osc.connect(gain).connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + ms / 1000)
  } catch {
    /* sound is a nicety */
  }
}
const buzz = () => {
  try {
    navigator.vibrate?.(60)
  } catch {
    /* not supported */
  }
}

const ScannerView = ({ continuous, onScan, onDone, audio }: { continuous: boolean; onScan: (code: string) => ScanResult | Promise<ScanResult>; onDone: () => void; audio: AudioContext | null }) => {
  const debouncer = useRef(createDebouncer())
  const busy = useRef(false)
  const lastRejected = useRef<string | null>(null)
  const [accepted, setAccepted] = useState<string[]>([])
  const [note, setNote] = useState<string | null>(null)

  const handle = useCallback(
    async (raw: string) => {
      const code = normalizeScan(raw)
      if (!code || busy.current || !debouncer.current.accept(code)) return
      busy.current = true
      try {
        const res = await onScan(code)
        if (res === false) {
          // The same rejected code held in front of the camera: say it once, stay quiet afterwards.
          if (lastRejected.current === code) return
          lastRejected.current = code
          setNote(`${code}: not added (already in the list or not accepted)`)
          beep(audio, 330, 140)
          return
        }
        lastRejected.current = null
        beep(audio)
        buzz()
        setNote(null)
        setAccepted((a) => [code, ...a].slice(0, 6))
        if (!continuous) onDone()
      } finally {
        busy.current = false
      }
    },
    [audio, continuous, onDone, onScan],
  )
  const { videoRef, state } = useBarcodeScanner(true, handle)

  return (
    <>
      {state.status === 'error' ? (
        <Alert variant="warning" className="mb-0">
          {state.error}
        </Alert>
      ) : (
        <div className="position-relative bg-black rounded overflow-hidden" style={{ aspectRatio: '4 / 3' }}>
          <video ref={videoRef} className="w-100 h-100" style={{ objectFit: 'cover' }} muted playsInline aria-label="Camera preview" />
          {state.status === 'scanning' && (
            <div className="position-absolute top-50 start-50 translate-middle border border-2 border-success rounded" style={{ width: '70%', height: '40%', pointerEvents: 'none', boxShadow: '0 0 0 9999px rgba(0,0,0,.25)' }} aria-hidden="true" />
          )}
        </div>
      )}
      <div className="small mt-2" aria-live="polite">
        {state.status === 'starting' && <span className="text-muted">Starting the camera…</span>}
        {state.status === 'scanning' && <span className="text-muted">Point the camera at a barcode or QR code{continuous ? '. Keep scanning; press Done when finished.' : '.'}</span>}
        {note && <div className="text-warning mt-1">{note}</div>}
      </div>
      {accepted.length > 0 && (
        <ul className="list-unstyled font-monospace small mt-2 mb-0" aria-label="Scanned codes">
          {accepted.map((c, i) => (
            <li key={`${c}-${i}`} className="text-success text-break">
              <Icon icon="check" className="me-1" />
              {c}
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

/**
 * "Scan with camera" button: opens a dialog with the live camera and reads barcodes / QR codes.
 * Uses the browser's BarcodeDetector when it has one, otherwise a lazily loaded ZXing decoder (no cost on normal pages).
 * Needs https:// or localhost. USB keyboard-wedge scanners do not need this button at all: they just type into the focused field.
 * NOT covered by automated tests (a headless browser has no camera); pure logic lives in scanLogic.ts and is tested.
 */
const BarcodeScanButton = ({ onScan, continuous = false, label = 'Scan', title = 'Scan with the camera', size, variant = 'tonal-secondary', disabled, className }: BarcodeScanButtonProps) => {
  const [open, setOpen] = useState(false)
  const [audio, setAudio] = useState<AudioContext | null>(null)
  const close = useCallback(() => setOpen(false), [])
  useEffect(() => () => void audio?.close().catch(() => {}), [audio])

  const openDialog = () => {
    // Created inside the click so mobile browsers let it play later.
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      const ctx = audio ?? (AC ? new AC() : null)
      void ctx?.resume()
      if (ctx && !audio) setAudio(ctx)
    } catch {
      /* no audio */
    }
    setOpen(true)
  }

  return (
    <>
      <Button type="button" size={size} variant={variant} className={className} disabled={disabled} onClick={openDialog} title={title} aria-label={title}>
        <Icon icon="camera" className={label ? 'me-1' : undefined} />
        {label}
      </Button>
      {open && (
        <Modal show onHide={close} centered aria-labelledby="scan-title">
          <Modal.Header closeButton>
            <Modal.Title id="scan-title" as="h5">
              Scan with the camera
            </Modal.Title>
          </Modal.Header>
          <Modal.Body>
            <ScannerView continuous={continuous} onScan={onScan} onDone={close} audio={audio} />
          </Modal.Body>
          <Modal.Footer>
            <Button variant={continuous ? 'primary' : 'light'} onClick={close}>
              {continuous ? 'Done' : 'Cancel'}
            </Button>
          </Modal.Footer>
        </Modal>
      )}
    </>
  )
}

export default BarcodeScanButton
