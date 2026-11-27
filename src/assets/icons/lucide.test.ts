import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildBundle, loadLucide } from '../../../scripts/icons-core'

const root = join(import.meta.dirname, '../../..')

describe('local Lucide icon bundle', () => {
  it('is up to date with the icon names used in src/ (run `npm run icons` after adding an icon)', () => {
    expect(readFileSync(join(root, 'src/assets/icons/lucide.json'), 'utf8')).toBe(buildBundle(root))
  })

  it('every <Icon icon="..."> and menu icon literal is a real Lucide icon (typos would render blank offline)', () => {
    const full = loadLucide(root)
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]))
    const used = new Set<string>()
    for (const f of walk(join(root, 'src')).filter((x) => /\.tsx?$/.test(x))) {
      for (const m of readFileSync(f, 'utf8').matchAll(/\bicon(?:=\{?|:\s*)["']([a-z0-9-]+)["']/g)) used.add(m[1])
    }
    expect(used.size).toBeGreaterThan(50)
    expect([...used].filter((n) => !full.icons[n] && !full.aliases?.[n])).toEqual([])
  })
})
