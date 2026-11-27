/**
 * README demo (docs/screenshots/demo.gif / demo.webm). Not part of the smoke run: `npm run demo:gif` (DEMO_VIDEO=1
 * scripts/e2e.sh e2e/demo-video.spec.ts, then scripts/demo-gif.sh) installs a throwaway instance, fills it with
 * `npm run seed:demo`, and records a ~30 second walkthrough at 1280x720 with Playwright video. The install, seeding and
 * login happen in a separate, unrecorded context; only the walkthrough is recorded. Demo data only.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { installViaWizard, login, requireHarness } from './helpers'

test.skip(!process.env.DEMO_VIDEO, 'run with `npm run demo:gif`')
const harness = process.env.DEMO_VIDEO ? requireHarness() : null

const OUT = 'test-results/demo'
const SIZE = { width: 1280, height: 720 }
const BRIEF_SERIAL = 'HIK123456789'

const wait = (page: Page, ms: number) => page.waitForTimeout(ms)

/** A small original cursor dot and click ripple, drawn by the page itself (the recording does not capture the OS cursor). */
const CURSOR_SCRIPT = `
(() => {
  const mk = () => {
    if (document.getElementById('demo-cursor')) return
    const style = document.createElement('style')
    style.textContent = '#demo-cursor{position:fixed;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(79,70,229,.85);border:2px solid #fff;box-shadow:0 1px 6px rgba(0,0,0,.35);z-index:2147483647;pointer-events:none;transition:transform .08s}#demo-cursor.down{transform:scale(.75)}.demo-ripple{position:fixed;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;border:3px solid rgba(79,70,229,.75);z-index:2147483646;pointer-events:none;animation:demo-ripple .55s ease-out forwards}@keyframes demo-ripple{to{transform:scale(4.2);opacity:0}}'
    document.head.appendChild(style)
    const dot = document.createElement('div')
    dot.id = 'demo-cursor'
    document.body.appendChild(dot)
    const place = (x, y) => { dot.style.left = x + 'px'; dot.style.top = y + 'px'; try { sessionStorage.setItem('demo-xy', x + ',' + y) } catch {} }
    let xy = [640, 420]
    try { xy = (sessionStorage.getItem('demo-xy') || '640,420').split(',').map(Number) } catch {}
    place(xy[0], xy[1])
    addEventListener('mousemove', (e) => place(e.clientX, e.clientY), true)
    addEventListener('mousedown', (e) => {
      dot.classList.add('down')
      const r = document.createElement('div')
      r.className = 'demo-ripple'
      r.style.left = e.clientX + 'px'
      r.style.top = e.clientY + 'px'
      document.body.appendChild(r)
      setTimeout(() => r.remove(), 700)
    }, true)
    addEventListener('mouseup', () => dot.classList.remove('down'), true)
  }
  if (document.body) mk(); else addEventListener('DOMContentLoaded', mk)
})()
`

let cursor = { x: 640, y: 420 }

/** Move the visible cursor to the centre of an element in a smooth arc, then optionally click it. */
async function glide(page: Page, target: Locator, opts: { click?: boolean } = {}) {
  await target.scrollIntoViewIfNeeded()
  const box = await target.boundingBox()
  if (!box) throw new Error('demo: element has no box')
  const x = box.x + Math.min(box.width / 2, 120)
  const y = box.y + box.height / 2
  const steps = 22
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2 // ease in-out
    await page.mouse.move(cursor.x + (x - cursor.x) * e, cursor.y + (y - cursor.y) * e)
    await page.waitForTimeout(14)
  }
  cursor = { x, y }
  await wait(page, 180)
  if (opts.click) {
    await page.mouse.down()
    await wait(page, 70)
    await page.mouse.up()
  }
}

/** Human-speed typing into a field (click first so the cursor visibly goes there). */
async function typeInto(page: Page, field: Locator, text: string, delay = 70) {
  await glide(page, field, { click: true })
  await field.pressSequentially(text, { delay })
}

/** Smooth scroll by `px` over `ms`. */
async function scrollBy(page: Page, px: number, ms: number) {
  const steps = 24
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, px / steps)
    await page.waitForTimeout(ms / steps)
  }
}

test('record the README demo walkthrough', async ({ browser }) => {
  test.setTimeout(300_000)
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })

  // ---- Setup (not recorded): install, demo data, login, find an in-stock unit to sell ----
  const setupCtx = await browser.newContext({ baseURL: process.env.E2E_BASE_URL, viewport: SIZE })
  const setup = await setupCtx.newPage()
  await installViaWizard(setup, 'Dhaka Digital Store')
  execFileSync(process.execPath, ['--import', 'tsx', 'scripts/seed-demo.ts', '--yes'], { stdio: 'inherit', env: { ...process.env, DATABASE_URL: harness!.databaseUrl, DB_DRIVER: 'pg' } })
  await login(setup)
  await setup.goto('/sales/new')
  // HIK123456789 is the brief's example and is already sold in the demo data (its story is the Serial Lookup scene), so the POS
  // scene sells the next in-stock unit of the same product.
  let sellSerial = ''
  for (let n = 123456800; n > 123456789 && !sellSerial; n--) {
    const scan = setup.locator('#scan')
    await scan.fill(`HIK${n}`)
    await scan.press('Enter')
    const ok = setup.getByText(`Added: Hikvision 2MP Bullet Camera · HIK${n}`)
    const bad = setup.locator('.text-danger, .alert-danger', { hasText: `HIK${n}` })
    await expect(ok.or(bad).first()).toBeVisible()
    if (await ok.isVisible()) sellSerial = `HIK${n}`
  }
  expect(sellSerial).not.toBe('')
  const storage = await setupCtx.storageState()
  await setupCtx.close()

  // ---- Recorded walkthrough ----
  const t0 = Date.now()
  const ctx = await browser.newContext({
    baseURL: process.env.E2E_BASE_URL,
    viewport: SIZE,
    deviceScaleFactor: 1,
    storageState: storage,
    recordVideo: { dir: OUT, size: SIZE },
  })
  await ctx.addInitScript(CURSOR_SCRIPT)
  const page = await ctx.newPage()
  page.setDefaultTimeout(20_000)

  // 1. Dashboard overview
  await page.goto('/dashboard')
  await expect(page.locator('canvas').first()).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  await wait(page, 500)
  writeFileSync(`${OUT}/trim-start.txt`, String((Date.now() - t0) / 1000 - 0.2)) // seconds of loading before the first useful frame
  await page.mouse.move(cursor.x, cursor.y)
  await wait(page, 1500)

  // 2. POS: scan, customer, price, partial payment, save
  await page.goto('/sales/new')
  const scan = page.locator('#scan')
  await expect(scan).toBeVisible()
  await wait(page, 600)
  await typeInto(page, scan, sellSerial)
  await wait(page, 250)
  await scan.press('Enter')
  await expect(page.getByText(`Added: Hikvision 2MP Bullet Camera · ${sellSerial}`)).toBeVisible()
  await wait(page, 700)
  const customer = page.getByRole('combobox', { name: 'Customer' })
  await typeInto(page, customer, 'Rahim')
  const option = page.getByRole('option', { name: /Rahim/ }).first()
  await expect(option).toBeVisible()
  await wait(page, 300)
  await glide(page, option, { click: true })
  await wait(page, 500)
  const price = page.getByLabel('Unit price line 1')
  await glide(page, price, { click: true })
  await price.press('ControlOrMeta+a')
  await price.pressSequentially('2800', { delay: 90 })
  await wait(page, 500)
  const pay = page.getByLabel('Payment 1 amount')
  await glide(page, pay, { click: true })
  await pay.press('ControlOrMeta+a')
  await pay.pressSequentially('1800', { delay: 90 })
  await wait(page, 700)
  await glide(page, page.getByRole('button', { name: 'Save sale' }), { click: true })
  await expect(page).toHaveURL(/\/sales\/[0-9a-f-]{36}/)
  await expect(page.getByText(/1,000\.00/).first()).toBeVisible() // the 1,000 still due
  await wait(page, 1700)

  // 3. Serial Lookup of the brief's serial: vendor, cost, sale, warranty, history timeline
  await page.goto('/serials')
  const box = page.getByLabel('Serial or IMEI')
  await wait(page, 300)
  await typeInto(page, box, BRIEF_SERIAL)
  await wait(page, 250)
  await box.press('Enter')
  await expect(page).toHaveURL(/\/serials\/[0-9a-f-]{36}/)
  await expect(page.getByText('ABC Electronics').first()).toBeVisible()
  await wait(page, 1900)
  await scrollBy(page, 420, 1100)
  await wait(page, 800)
  await scrollBy(page, 520, 1100)
  await wait(page, 1500)

  // 4. Stock
  await page.goto('/stock')
  await expect(page.getByText('Hikvision 2MP Bullet Camera').first()).toBeVisible()
  await wait(page, 1600)

  // 5. Profit & Loss
  await page.goto('/reports/profit-loss')
  await expect(page.getByText(/Cost of goods sold/i).first()).toBeVisible()
  await wait(page, 1700)

  // 6. Bengali typography
  await page.goto('/customers')
  await wait(page, 400)
  await glide(page, page.getByRole('link', { name: 'সুমাইয়া আক্তার', exact: true }), { click: true })
  await expect(page.getByRole('heading', { name: /সুমাইয়া আক্তার/ }).first()).toBeVisible()
  await wait(page, 1700)

  // 7. Back to the dashboard
  await page.goto('/dashboard')
  await expect(page.locator('canvas').first()).toBeVisible()
  await wait(page, 1500)

  const video = page.video()
  await ctx.close() // flushes the .webm
  if (!video) throw new Error('demo: no video was recorded')
  console.log(`DEMO_WEBM=${await video.path()}`)
})
