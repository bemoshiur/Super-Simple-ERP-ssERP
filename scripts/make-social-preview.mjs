#!/usr/bin/env node
/**
 * Render docs/social-preview.png (1280 x 640) from an inline HTML template with Playwright's Chromium.
 * Deterministic and offline: the app's own palette (src/assets/scss/_tokens.scss), its logo mark (src/components/Wordmark.tsx)
 * and the self-hosted Nunito font from src/assets/fonts. No third-party assets. See docs/SOCIAL_PREVIEW.md.
 *
 *   npx playwright install chromium   # once
 *   node scripts/make-social-preview.mjs
 */
import { readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'docs', 'social-preview.png')
const MAX_BYTES = 300 * 1024
const font = readFileSync(join(root, 'src/assets/fonts/nunito-latin-wght-normal.woff2')).toString('base64')

// Palette: src/assets/scss/_tokens.scss
const c = { ink: '#10273a', inkRaised: '#173550', brand: '#1b6b8f', accent: '#4cc3bd', onInk: '#c8d6e2', onInkMuted: '#9fb3c4', white: '#ffffff' }

// Logo mark (light tone), the same geometry as LogoMark in src/components/Wordmark.tsx.
const mark = (size) => `
<svg width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true">
  <rect width="32" height="32" rx="8" fill="${c.accent}"/>
  <rect x="7" y="8.5" width="18" height="3" rx="1.5" fill="${c.ink}"/>
  <rect x="7" y="14.5" width="12" height="3" rx="1.5" fill="${c.ink}" opacity="0.85"/>
  <rect x="7" y="20.5" width="7" height="3" rx="1.5" fill="${c.ink}" opacity="0.7"/>
  <circle cx="22.5" cy="22" r="2.75" fill="${c.ink}"/>
</svg>`

const steps = ['Vendor', 'Purchase', 'Stock', 'Sale', 'Customer', 'Warranty']

const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
@font-face { font-family: Nunito; src: url(data:font/woff2;base64,${font}) format('woff2'); font-weight: 200 1000; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 1280px; height: 640px; }
body { font-family: Nunito, sans-serif; background: ${c.ink}; color: ${c.white}; position: relative; overflow: hidden; }
.band { position: absolute; right: 0; top: 0; width: 420px; height: 640px; background: ${c.inkRaised}; }
.rule { position: absolute; left: 96px; right: 96px; bottom: 96px; height: 2px; background: ${c.brand}; }
.wrap { position: absolute; left: 96px; top: 96px; right: 96px; }
.brand { display: flex; align-items: center; gap: 28px; }
.word { font-size: 112px; font-weight: 800; letter-spacing: -2px; line-height: 1; }
.word b { color: ${c.accent}; font-weight: 800; }
h1 { margin-top: 44px; font-size: 54px; font-weight: 800; line-height: 1.12; max-width: 760px; color: ${c.white}; }
.sub { margin-top: 20px; font-size: 28px; font-weight: 600; color: ${c.onInk}; }
.flow { position: absolute; left: 96px; bottom: 122px; display: flex; gap: 12px; align-items: center; font-size: 24px; font-weight: 700; color: ${c.onInk}; }
.flow span.step { padding: 8px 18px; border: 2px solid ${c.brand}; border-radius: 999px; }
.flow span.arrow { color: ${c.accent}; }
.foot { position: absolute; left: 96px; bottom: 50px; font-size: 22px; font-weight: 600; color: ${c.onInkMuted}; }
.tag { position: absolute; right: 110px; top: 140px; width: 260px; padding: 22px; border-radius: 16px; background: ${c.white}; color: ${c.ink}; font-weight: 800; }
.tag .t { font-size: 18px; color: ${c.brand}; text-transform: uppercase; letter-spacing: 2px; }
.tag .s { margin-top: 10px; font-size: 26px; letter-spacing: 0.5px; font-variant-numeric: tabular-nums; }
.bars { margin-top: 16px; display: flex; gap: 3px; height: 54px; }
.bars i { display: block; background: ${c.ink}; }
</style></head><body>
<div class="band"></div>
<div class="wrap">
  <div class="brand">${mark(104)}<div class="word">ss<b>ERP</b></div></div>
  <h1>Serial-tracked ERP, inventory &amp; billing</h1>
  <div class="sub">Open source (MIT) &middot; Next.js &middot; PostgreSQL</div>
</div>
<div class="tag"><div class="t">Serial / IMEI</div><div class="s">HIK123456789</div>
  <div class="bars">${[3, 1, 2, 1, 1, 3, 2, 1, 3, 1, 1, 2, 3, 1, 2, 1, 1, 3, 1, 2, 2, 1, 3, 1, 2, 1, 3, 2, 1, 1, 2, 3]
    .map((w) => `<i style="width:${w * 2}px"></i>`)
    .join('')}</div></div>
<div class="flow">${steps.map((s) => `<span class="step">${s}</span>`).join('<span class="arrow">&rarr;</span>')}</div>
<div class="rule"></div>
<div class="foot">github.com/bemoshiur/Super-Simple-ERP-ssERP</div>
</body></html>`

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1 })
  await page.setContent(html, { waitUntil: 'load' })
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: out, type: 'png', fullPage: false, animations: 'disabled' })
} finally {
  await browser.close()
}

const size = statSync(out).size
console.log(`Wrote ${relative(root, out)} (1280x640, ${(size / 1024).toFixed(1)} KB)`)
if (size > MAX_BYTES) {
  console.error(`Too large: ${size} bytes > ${MAX_BYTES}. Simplify the template.`)
  process.exit(1)
}
