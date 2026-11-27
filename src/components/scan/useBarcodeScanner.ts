'use client'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { SCAN_FORMATS, cameraErrorMessage, cameraSupport, type ScanFormat } from './scanLogic'

// Minimal typing of the Shape Detection API (not in lib.dom).
type DetectedBarcode = { rawValue: string; format: string }
type BarcodeDetectorLike = { detect: (source: CanvasImageSource) => Promise<DetectedBarcode[]> }
type BarcodeDetectorCtor = { new (opts?: { formats?: string[] }): BarcodeDetectorLike; getSupportedFormats?: () => Promise<string[]> }

export type ScannerStatus = 'idle' | 'starting' | 'scanning' | 'error'
export type ScannerState = { status: ScannerStatus; error: string | null; engine: 'native' | 'zxing' | null }

/** The browser's own detector when it supports at least one of our formats; otherwise null (use ZXing). */
async function nativeDetector(): Promise<BarcodeDetectorLike | null> {
  const Ctor = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector
  if (!Ctor) return null
  try {
    const supported = Ctor.getSupportedFormats ? await Ctor.getSupportedFormats() : [...SCAN_FORMATS]
    const formats = SCAN_FORMATS.filter((f) => supported.includes(f))
    if (formats.length === 0) return null
    return new Ctor({ formats })
  } catch {
    return null
  }
}

const ZXING_NAMES: Record<ScanFormat, string> = { code_128: 'CODE_128', code_39: 'CODE_39', ean_13: 'EAN_13', ean_8: 'EAN_8', qr_code: 'QR_CODE', upc_a: 'UPC_A', itf: 'ITF', data_matrix: 'DATA_MATRIX' }

/**
 * Starts the camera while `active` and calls `onDetect(rawText)` for every read (the caller debounces/normalises).
 * Everything is torn down on `active=false` and on unmount: scan loop, ZXing controls and every MediaStream track
 * (so the camera light goes off). ZXing is imported dynamically, only when the browser has no BarcodeDetector.
 * Decoding is fully local; nothing is sent over the network.
 */
export function useBarcodeScanner(active: boolean, onDetect: (raw: string) => void): { videoRef: RefObject<HTMLVideoElement | null>; state: ScannerState } {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const onDetectRef = useRef(onDetect)
  const [state, setState] = useState<ScannerState>({ status: 'idle', error: null, engine: null })
  useEffect(() => {
    onDetectRef.current = onDetect
  })

  useEffect(() => {
    if (!active) return
    let cancelled = false
    let stream: MediaStream | null = null
    let timer: ReturnType<typeof setInterval> | null = null
    let controls: { stop: () => void } | null = null
    const video = videoRef.current

    const teardown = () => {
      if (timer) clearInterval(timer)
      timer = null
      try {
        controls?.stop()
      } catch {
        /* already stopped */
      }
      controls = null
      stream?.getTracks().forEach((t) => t.stop())
      stream = null
      if (video) {
        video.pause()
        video.srcObject = null
      }
    }
    const fail = (message: string) => {
      teardown()
      if (!cancelled) setState({ status: 'error', error: message, engine: null })
    }

    void (async () => {
      const support = cameraSupport({ isSecureContext: window.isSecureContext, hasMediaDevices: !!navigator.mediaDevices?.getUserMedia })
      if (!support.ok) return fail(support.message)
      setState({ status: 'starting', error: null, engine: null })
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      } catch (e) {
        return fail(cameraErrorMessage(e))
      }
      if (cancelled || !video) return teardown()
      video.srcObject = stream
      video.muted = true
      video.setAttribute('playsinline', 'true')
      try {
        await video.play()
      } catch {
        /* autoplay quirks: frames still arrive once the element is visible */
      }
      if (cancelled) return teardown()

      const native = await nativeDetector()
      if (cancelled) return teardown()
      if (native) {
        let busy = false
        timer = setInterval(async () => {
          if (busy || video.readyState < 2) return
          busy = true
          try {
            const found = await native.detect(video)
            const text = found[0]?.rawValue
            if (text) onDetectRef.current(text)
          } catch {
            /* a frame that cannot be read is skipped */
          }
          busy = false
        }, 200)
        setState({ status: 'scanning', error: null, engine: 'native' })
        return
      }
      try {
        const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([import('@zxing/browser'), import('@zxing/library')])
        if (cancelled) return teardown()
        const hints = new Map([[DecodeHintType.POSSIBLE_FORMATS, SCAN_FORMATS.map((f) => BarcodeFormat[ZXING_NAMES[f] as keyof typeof BarcodeFormat])]])
        const reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 150 })
        const c = await reader.decodeFromStream(stream, video, (result) => {
          if (result) onDetectRef.current(result.getText())
        })
        if (cancelled) {
          c.stop()
          return teardown()
        }
        controls = c
        setState({ status: 'scanning', error: null, engine: 'zxing' })
      } catch {
        fail('The barcode reader could not be loaded. Reload the page, or use a USB barcode scanner.')
      }
    })()

    return () => {
      cancelled = true
      teardown()
    }
  }, [active])

  return { videoRef, state }
}
