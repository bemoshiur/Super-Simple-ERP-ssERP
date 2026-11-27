/**
 * README screenshots (docs/screenshots/*.png). Not part of the smoke run: `npm run screenshots` (SCREENSHOTS=1
 * scripts/e2e.sh) installs a throwaway instance, fills it with `npm run seed:demo`, and captures the main screens at
 * 1280 px. PNGs are palette-quantised with sharp (already installed by Next.js) to keep each well under ~150 KB.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import sharp from 'sharp'
import { installViaWizard, login, requireHarness } from './helpers'

test.skip(!process.env.SCREENSHOTS, 'run with `npm run screenshots`')
const harness = process.env.SCREENSHOTS ? requireHarness() : null
test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })

const OUT = 'docs/screenshots'

async function shot(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready)
  await page.mouse.move(0, 0)
  const png = await page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' })
  const out = `${OUT}/${name}.png`
  const info = await sharp(png).png({ palette: true, quality: 80, effort: 10, compressionLevel: 9 }).toFile(out)
  console.log(`${out}: ${Math.round(info.size / 1024)} KB`)
}

test('capture README screenshots', async ({ page }) => {
  test.setTimeout(300_000)
  mkdirSync(OUT, { recursive: true })
  await installViaWizard(page, 'Dhaka Digital Store')
  // Demo data through the real data layer (local throwaway database, so no confirmation is needed).
  // Explicitly the harness's throwaway database, never an ambient DATABASE_URL from the developer's shell or .env.local.
  execFileSync(process.execPath, ['--import', 'tsx', 'scripts/seed-demo.ts', '--yes'], { stdio: 'inherit', env: { ...process.env, DATABASE_URL: harness!.databaseUrl, DB_DRIVER: 'pg' } })
  await login(page)

  await page.goto('/dashboard')
  await expect(page.locator('canvas').first()).toBeVisible()
  await shot(page, 'dashboard')

  await page.goto('/sales/new')
  const scan = page.locator('#scan')
  // add the first two demo units that are still in stock
  let added = 0
  for (let n = 123456800; n >= 123456789 && added < 2; n--) {
    await scan.fill(`HIK${n}`)
    await scan.press('Enter')
    const ok = page.getByText(`Added: Hikvision 2MP Bullet Camera · HIK${n}`)
    const bad = page.locator('.text-danger, .alert-danger', { hasText: `HIK${n}` })
    await expect(ok.or(bad).first()).toBeVisible()
    if (await ok.isVisible()) added++
  }
  expect(added).toBe(2)
  await page.getByRole('combobox', { name: 'Customer' }).fill('সুমাইয়া')
  await page.getByRole('option', { name: /সুমাইয়া/ }).first().click()
  await page.getByLabel('Payment 1 amount').fill('3000')
  await shot(page, 'pos')

  await page.goto('/serials')
  await page.getByLabel('Serial or IMEI').fill('HIK123456789')
  await page.getByLabel('Serial or IMEI').press('Enter')
  await expect(page).toHaveURL(/\/serials\/[0-9a-f-]{36}/)
  await shot(page, 'serial-lookup')
  const labelsHref = await page.locator('a[href^="/serials/labels"]').first().getAttribute('href')

  await page.goto('/stock')
  await shot(page, 'stock')

  await page.goto('/customers')
  await page.getByRole('link', { name: 'সুমাইয়া আক্তার', exact: true }).click()
  await expect(page.getByRole('heading', { name: /সুমাইয়া আক্তার/ }).first()).toBeVisible()
  await shot(page, 'bengali-customer')

  await page.goto('/purchases/import')
  await page.getByLabel('Vendor').fill('a')
  await page.getByRole('option').first().click()
  const csv = ['serial,product_sku,unit_cost,warranty_months,note', 'HIK900000001,CAM-HIK-2MP,2000,12,', 'HIK900000002,CAM-HIK-2MP,2000,12,', '356700000000001,PHN-REDMI-13C,"12,500.00",12,Box opened', 'HIK123456789,CAM-HIK-2MP,2000,12,already recorded', 'XX-1,NO-SUCH-SKU,100,0,'].join('\n')
  await page.getByLabel('CSV file').setInputFiles({ name: 'serials.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
  await page.getByRole('button', { name: 'Check file (dry run)' }).click()
  await expect(page.getByText(/NO-SUCH-SKU/).first()).toBeVisible()
  await shot(page, 'purchase-import')

  await page.goto('/reports/profit-loss')
  await expect(page.getByText(/Cost of goods sold/i).first()).toBeVisible()
  await shot(page, 'profit-loss')

  // a second branch and a transfer form, then the branch list
  await page.goto('/settings/branches')
  await page.getByRole('button', { name: 'New branch' }).click()
  await page.getByRole('dialog').getByLabel('Name').fill('Chattogram')
  await page.getByRole('dialog').getByLabel('Code').fill('CTG')
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('dialog')).toBeHidden()
  await page.goto('/stock/transfers/new')
  await page.getByLabel('Serial units (one per line)').fill('HIK123456795\nHIK123456796')
  await shot(page, 'branches-transfer')

  if (labelsHref) {
    await page.goto(labelsHref)
    await expect(page.locator('svg, canvas, img').first()).toBeVisible()
    await shot(page, 'labels')
  }

  await page.goto('/roles')
  await shot(page, 'roles')
})
