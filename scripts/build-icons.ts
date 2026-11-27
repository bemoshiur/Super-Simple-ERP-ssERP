// npm run icons: regenerate src/assets/icons/lucide.json (see scripts/icons-core.ts).
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildBundle } from './icons-core'

const root = join(import.meta.dirname, '..')
const out = join(root, 'src/assets/icons/lucide.json')
const text = buildBundle(root)
writeFileSync(out, text)
console.log(`Wrote ${out} (${Object.keys(JSON.parse(text).icons).length} icons, ${Math.round(text.length / 1024)} KB)`)
