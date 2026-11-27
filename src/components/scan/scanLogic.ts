/**
 * Pure helpers behind the camera scanner (no DOM, no React): safe to unit-test.
 * The camera UI itself (getUserMedia, BarcodeDetector, ZXing) cannot run in a unit test; see BarcodeScanButton.tsx.
 */
import { normalizeSerial } from '../../server/purchases/serialInput'

/** Formats offered to both engines: BarcodeDetector names, mapped to ZXing names in useBarcodeScanner. */
export const SCAN_FORMATS = ['code_128', 'code_39', 'ean_13', 'ean_8', 'qr_code', 'upc_a', 'itf', 'data_matrix'] as const
export type ScanFormat = (typeof SCAN_FORMATS)[number]

/** How long the same code is ignored after it was accepted (a camera reads the same label many times per second). */
export const DUPLICATE_WINDOW_MS = 1500

/** Same cleaning as typed/pasted serials: strip BOM / zero-width characters, trim. Case is preserved. */
export const normalizeScan = (raw: string): string => normalizeSerial(String(raw ?? ''))

/** Accepts a code at most once per `windowMs`. `now` is injectable for tests. */
export function createDebouncer(windowMs = DUPLICATE_WINDOW_MS, now: () => number = () => Date.now()) {
  const seen = new Map<string, number>()
  return {
    /** true = new read, act on it; false = a repeat of the same code inside the window. */
    accept(code: string): boolean {
      const t = now()
      const prev = seen.get(code)
      seen.set(code, t)
      // forget old entries so the map stays tiny during a long session
      if (seen.size > 50) for (const [k, v] of seen) if (t - v > windowMs) seen.delete(k)
      return prev === undefined || t - prev >= windowMs
    },
    reset() {
      seen.clear()
    },
  }
}

/** Append one scanned code as a new line of a textarea value; returns null when that exact line is already there. */
export function appendScanLine(text: string, code: string): string | null {
  const lines = text.split(/[\r\n,\t]+/).map(normalizeSerial)
  if (lines.includes(code)) return null
  const base = text.replace(/\s+$/, '')
  return base ? `${base}\n${code}` : code
}

export type CameraEnv = { isSecureContext?: boolean; hasMediaDevices?: boolean; hostname?: string }

/** Can this page ask for the camera at all? getUserMedia exists only on https:// or localhost. */
export function cameraSupport(env: CameraEnv): { ok: true } | { ok: false; message: string } {
  if (env.isSecureContext === false)
    return { ok: false, message: 'The camera works only on a secure connection. Open ssERP over https:// (or on localhost) to scan with the camera. A USB barcode scanner works on any address.' }
  if (!env.hasMediaDevices) return { ok: false, message: 'This browser cannot use the camera here (no camera API). Try Chrome, Edge, Firefox or Safari, or use a USB barcode scanner.' }
  return { ok: true }
}

/** Friendly text for a getUserMedia failure (DOMException names). */
export function cameraErrorMessage(e: unknown): string {
  const name = typeof e === 'object' && e && 'name' in e ? String((e as { name: unknown }).name) : ''
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'Camera permission was denied. Allow the camera for this site in the browser settings (the padlock or camera icon in the address bar), then try again.'
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'No camera was found on this device. Use a USB barcode scanner or type the serial.'
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'The camera is busy or not available (another app or tab may be using it). Close it and try again.'
    default:
      return 'The camera could not be started. Check the permission and that no other app is using it, then try again.'
  }
}
