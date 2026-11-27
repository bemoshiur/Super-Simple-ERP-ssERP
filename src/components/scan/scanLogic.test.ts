import { describe, expect, it } from 'vitest'
import { DUPLICATE_WINDOW_MS, SCAN_FORMATS, appendScanLine, cameraErrorMessage, cameraSupport, createDebouncer, normalizeScan } from './scanLogic'

describe('normalizeScan', () => {
  it('strips BOM / zero-width characters and whitespace like the serial normaliser; keeps case and Bengali', () => {
    expect(normalizeScan('﻿ 356789012345678​\n')).toBe('356789012345678')
    expect(normalizeScan('Ab-12')).toBe('Ab-12')
    expect(normalizeScan('সিরিয়াল-১')).toBe('সিরিয়াল-১')
    expect(normalizeScan('   ')).toBe('')
    expect(normalizeScan(undefined as unknown as string)).toBe('')
  })
})

describe('createDebouncer', () => {
  it('ignores the same code inside the window and accepts it again after', () => {
    let t = 1000
    const d = createDebouncer(DUPLICATE_WINDOW_MS, () => t)
    expect(DUPLICATE_WINDOW_MS).toBe(1500)
    expect(d.accept('A')).toBe(true)
    t += 200
    expect(d.accept('A')).toBe(false)
    t += 1200 // 1400 ms after the first read, but the repeat at +200 restarted nothing: measured from the LAST read (1000+200)
    expect(d.accept('A')).toBe(false)
    t += 1600
    expect(d.accept('A')).toBe(true)
  })
  it('different codes do not block each other (continuous intake)', () => {
    let t = 0
    const d = createDebouncer(1500, () => t)
    expect(d.accept('A')).toBe(true)
    t += 50
    expect(d.accept('B')).toBe(true)
    t += 50
    expect(d.accept('A')).toBe(false)
    d.reset()
    expect(d.accept('A')).toBe(true)
  })
  it('exactly at the window edge counts as new; the map does not grow forever', () => {
    let t = 0
    const d = createDebouncer(1500, () => t)
    d.accept('A')
    t = 1500
    expect(d.accept('A')).toBe(true)
    for (let i = 0; i < 500; i++) {
      t += 2000
      d.accept(`C${i}`)
    }
    expect(d.accept('C499')).toBe(false)
  })
})

describe('appendScanLine', () => {
  it('appends on a new line, skips codes already present, handles empty text and trailing newlines', () => {
    expect(appendScanLine('', 'A1')).toBe('A1')
    expect(appendScanLine('A1', 'A2')).toBe('A1\nA2')
    expect(appendScanLine('A1\n', 'A2')).toBe('A1\nA2')
    expect(appendScanLine('A1\nA2', 'A1')).toBeNull()
    expect(appendScanLine('A1, A2\tA3', 'A3')).toBeNull()
    expect(appendScanLine('a1', 'A1')).toBe('a1\nA1') // case-sensitive like the server
  })
})

describe('camera support + errors', () => {
  it('explains the https requirement', () => {
    const r = cameraSupport({ isSecureContext: false, hasMediaDevices: false })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.message).toMatch(/https:\/\/.*localhost/)
    expect(cameraSupport({ isSecureContext: true, hasMediaDevices: false }).ok).toBe(false)
    expect(cameraSupport({ isSecureContext: true, hasMediaDevices: true })).toEqual({ ok: true })
  })
  it('maps permission denied, no camera, busy camera and unknown errors to different messages', () => {
    const m = (name: string) => cameraErrorMessage({ name })
    expect(m('NotAllowedError')).toMatch(/permission was denied/)
    expect(m('NotFoundError')).toMatch(/No camera/)
    expect(m('NotReadableError')).toMatch(/busy/)
    expect(m('Whatever')).toMatch(/could not be started/)
    expect(cameraErrorMessage(null)).toMatch(/could not be started/)
    expect(new Set(['NotAllowedError', 'NotFoundError', 'NotReadableError', 'x'].map(m)).size).toBe(4)
  })
  it('offers exactly the formats the brief lists', () => {
    expect([...SCAN_FORMATS]).toEqual(['code_128', 'code_39', 'ean_13', 'ean_8', 'qr_code', 'upc_a', 'itf', 'data_matrix'])
  })
})
