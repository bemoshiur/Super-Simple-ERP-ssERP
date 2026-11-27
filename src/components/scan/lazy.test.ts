import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import BarcodeScanButton from './BarcodeScanButton'

const dir = import.meta.dirname

describe('camera decoder cost', () => {
  it('ZXing is only ever loaded through dynamic import(), never statically, anywhere in src/', () => {
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.join(d, e.name)] : []))
    const offenders = walk(path.resolve(dir, '../..'))
      .filter((f) => !f.endsWith('.test.ts') && !f.endsWith('labels.test.ts'))
      .filter((f) => /from\s+['"]@zxing\//.test(readFileSync(f, 'utf8')) && !/labels\/pure/.test(f))
    // the label tests decode with ZXing in vitest only; production files must have none
    expect(offenders).toEqual([])
    expect(readFileSync(path.join(dir, 'useBarcodeScanner.ts'), 'utf8')).toMatch(/import\('@zxing\/browser'\)/)
  })
  it('renders only a button on a normal page: no dialog, no camera, no <video>', () => {
    const html = renderToStaticMarkup(createElement(BarcodeScanButton, { onScan: () => {}, title: 'Scan serials' }))
    expect(html).toContain('<button')
    expect(html).toContain('Scan serials')
    expect(html).not.toContain('<video')
    expect(html).not.toContain('modal')
  })
})
