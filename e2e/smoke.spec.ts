/**
 * End-to-end smoke test: ONE serial flow through the real app (production build, throwaway PostgreSQL).
 * Run with `npm run test:e2e` (scripts/e2e.sh starts the database and the app and sets E2E_BASE_URL / E2E_INSTALL_TOKEN).
 */
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { ADMIN, installViaWizard, requireHarness } from './helpers'

requireHarness()

const SERIALS = ['E2E-SN-0001', 'E2E-SN-0002', 'E2E-SN-0003']
const PRODUCT = 'E2E Camera 2MP'
const CUSTOMER = 'করিম ইলেকট্রনিক্স' // Bengali name: exercises the Noto Sans Bengali font stack

test.describe.configure({ mode: 'serial' })

/** Page-level problems collected for the whole run: CSP violations, Iconify API calls, uncaught errors. */
function watch(page: Page) {
  const problems: string[] = []
  page.on('console', (m) => {
    const t = m.text()
    if (/Content[- ]Security[- ]Policy|Refused to/i.test(t)) problems.push(`CSP: ${t.slice(0, 160)} @ ${page.url()} ${m.location().url}:${m.location().lineNumber}`)
  })
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
  page.on('request', (r) => {
    if (/iconify\.design|simplesvg\.com|unisvg\.com/.test(r.url())) problems.push(`network: ${r.url()}`)
  })
  return problems
}

/** axe-core WCAG 2.1 A/AA scan; serious/critical violations fail the test (soft, so the flow still runs to the end). */
async function axe(page: Page, name: string) {
  const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
  const bad = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  const summary = bad.map((v) => `${v.id} (${v.impact}): ${v.nodes.length} node(s), e.g. ${v.nodes[0]?.target.join(' ')} :: ${v.nodes[0]?.failureSummary?.replace(/\s+/g, ' ').slice(0, 300)}`)
  const minor = res.violations.filter((v) => !bad.includes(v)).map((v) => `${v.id} (${v.impact})`)
  const detail = bad.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => ({ target: n.target.join(' '), html: n.html.slice(0, 160), why: n.failureSummary?.replace(/\s+/g, ' ').slice(0, 220) })) }))
  await test.info().attach(`axe-${name}`, { body: JSON.stringify({ serious: detail, other: minor }, null, 2), contentType: 'application/json' })
  const { mkdirSync, writeFileSync } = await import('node:fs')
  mkdirSync('test-results', { recursive: true })
  writeFileSync(`test-results/axe-${name.replace(/[^a-z0-9]+/gi, '-')}.json`, JSON.stringify({ serious: detail, other: minor }, null, 2))
  expect.soft(summary, `axe serious/critical violations on ${name}`).toEqual([])
}

/** SearchSelect: type into the combobox and pick the option that contains `text`. */
async function pick(page: Page, combo: ReturnType<Page['getByRole']>, query: string, text: string | RegExp = query) {
  await combo.fill(query)
  const option = page.getByRole('option', { name: text }).first()
  await expect(option).toBeVisible()
  await option.click()
}

test('install → sell a serial → look it up → return → reports → transfer → sign out', async ({ page }) => {
  const problems = watch(page)

  await test.step('security headers', async () => {
    const res = await page.request.get('/auth/login')
    const h = res.headers()
    expect(h['x-content-type-options']).toBe('nosniff')
    expect(h['x-frame-options']).toBe('DENY')
    expect(h['referrer-policy']).toBe('strict-origin-when-cross-origin')
    expect(h['permissions-policy']).toContain('camera=(self)')
    expect(h['content-security-policy'] ?? h['content-security-policy-report-only']).toContain("frame-ancestors 'none'")
    expect(h['x-powered-by']).toBeUndefined()
  })

  await test.step('install wizard (token protected)', async () => {
    await installViaWizard(page)
    // the installer is locked now
    const again = await page.request.get('/install')
    expect(again.status()).toBe(403)
  })

  await test.step('admin login', async () => {
    await page.goto('/auth/login')
    await axe(page, 'login')
    await page.getByLabel('Email').fill(ADMIN.email)
    await page.getByLabel('Password').fill(ADMIN.password)
    await page.getByRole('button', { name: /sign in/i }).click()
    await expect(page).toHaveURL(/\/dashboard/)
    await expect(page.getByRole('heading', { name: 'Dashboard' }).first()).toBeVisible()
    await axe(page, 'dashboard')
  })

  await test.step('vendor, customer, category, serial product', async () => {
    await page.goto('/vendors')
    await page.getByRole('button', { name: 'Add vendor' }).click()
    await page.getByLabel('Name').fill('E2E Distributor')
    await page.getByRole('dialog').getByRole('button', { name: /^Save/ }).click()
    await expect(page.getByRole('dialog')).toBeHidden()
    await expect(page.getByRole('link', { name: 'E2E Distributor', exact: true })).toBeVisible()

    await page.goto('/customers')
    await page.getByRole('button', { name: 'Add customer' }).click()
    await page.getByLabel('Name').fill(CUSTOMER)
    await page.getByLabel('Phone').fill('01700000000')
    await page.getByRole('dialog').getByRole('button', { name: /^Save/ }).click()
    await expect(page.getByRole('dialog')).toBeHidden()
    await expect(page.getByRole('link', { name: CUSTOMER, exact: true })).toBeVisible()

    await page.goto('/categories')
    await page.getByRole('button', { name: 'Add category' }).click()
    await page.getByLabel('Name').fill('CCTV Cameras')
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()
    await expect(page.getByRole('dialog')).toBeHidden()

    await page.goto('/products')
    await page.getByRole('button', { name: 'Add product' }).click()
    const dlg = page.getByRole('dialog')
    await dlg.getByLabel('Product name').fill(PRODUCT)
    await dlg.getByLabel('SKU').fill('E2E-CAM-1')
    await pick(page, dlg.getByLabel('Category'), 'CCTV', 'CCTV Cameras')
    await dlg.getByLabel('Purchase price').fill('2,000')
    await dlg.getByLabel('Sale price').fill('2,800')
    await dlg.getByLabel('Warranty (months)').fill('12')
    await dlg.getByLabel('Track serial / IMEI per unit').check()
    await dlg.getByRole('button', { name: 'Save product' }).click()
    await expect(dlg).toBeHidden()
    await expect(page.getByRole('link', { name: PRODUCT, exact: true })).toBeVisible()
  })

  await test.step('purchase with serials', async () => {
    await page.goto('/purchases/new')
    await pick(page, page.getByRole('combobox', { name: 'Vendor' }), 'E2E', 'E2E Distributor')
    await pick(page, page.getByRole('combobox', { name: /Product line 1|Search product/ }).first(), 'E2E-CAM', PRODUCT)
    await page.getByLabel('Quantity line 1').fill(String(SERIALS.length))
    await page.getByLabel('Unit cost line 1').fill('2000')
    await page.getByLabel(/Serial \/ IMEI numbers for line 1/).fill(SERIALS.join('\n'))
    await page.getByLabel('Paid now').fill('6000')
    await page.getByLabel('Paid from').selectOption({ label: 'Cash' })
    await page.getByRole('button', { name: 'Save purchase' }).click()
    await expect(page).toHaveURL(/\/purchases\/[0-9a-f-]{36}$/)
    await expect(page.getByText(SERIALS[0], { exact: true }).first()).toBeVisible()
  })

  let saleUrl = ''
  await test.step('scan-sell with a partial payment', async () => {
    await page.goto('/sales/new')
    await axe(page, 'POS (sales/new)')
    const scan = page.locator('#scan')
    await scan.fill(SERIALS[0])
    await scan.press('Enter')
    await expect(page.getByText(SERIALS[0], { exact: true }).first()).toBeVisible()
    await pick(page, page.getByRole('combobox', { name: 'Customer' }), 'করিম', CUSTOMER)
    await page.getByLabel('Payment 1 amount').fill('1000')
    await page.getByRole('button', { name: 'Save sale' }).click()
    await expect(page).toHaveURL(/\/sales\/[0-9a-f-]{36}/)
    saleUrl = new URL(page.url()).pathname
    await expect(page.getByText(CUSTOMER).first()).toBeVisible()
    await expect(page.getByText(/1,800\.00/).first()).toBeVisible() // due = 2,800 - 1,000
  })

  await test.step('serial lookup shows the whole story', async () => {
    await page.goto('/serials')
    const box = page.getByLabel('Serial or IMEI')
    await box.fill(SERIALS[0])
    await box.press('Enter')
    await expect(page).toHaveURL(/\/serials\/[0-9a-f-]{36}/)
    for (const fact of [SERIALS[0], PRODUCT, 'E2E Distributor', CUSTOMER]) await expect(page.getByText(fact).first()).toBeVisible()
    await expect(page.getByText(/sold/i).first()).toBeVisible()
    await axe(page, 'serial lookup')
  })

  await test.step('customer return', async () => {
    await page.goto(saleUrl)
    await page.getByRole('button', { name: 'Return items' }).click()
    const dlg = page.getByRole('dialog')
    await dlg.getByLabel(`Return ${SERIALS[0]}`).check()
    await dlg.getByRole('button', { name: 'Return 1 item' }).click()
    await expect(dlg).toBeHidden()
    // the return row is listed on the sale, and the unit is back in stock (its own serial page says so)
    await expect(page.getByRole('heading', { name: 'No returns' })).toBeHidden()
    const returns = page.getByRole('heading', { name: 'Returns', exact: true }).locator('xpath=..')
    await expect(returns.getByRole('row').nth(1)).toBeVisible()
    await page.goto('/serials')
    await page.getByLabel('Serial or IMEI').fill(SERIALS[0])
    await page.getByLabel('Serial or IMEI').press('Enter')
    await expect(page).toHaveURL(/\/serials\/[0-9a-f-]{36}/)
    await expect(page.locator('.badge', { hasText: /^In stock$/ }).first()).toBeVisible()
  })

  await test.step('stock, reports hub and users/roles pass axe', async () => {
    await page.goto('/stock')
    await expect(page.getByRole('heading', { name: 'Stock', level: 1 })).toBeVisible()
    await axe(page, 'stock')
    await page.goto('/reports')
    await expect(page.getByRole('heading', { name: 'Reports', level: 1 })).toBeVisible()
    await axe(page, 'reports')
    await page.goto('/users')
    await axe(page, 'users')
    await page.goto('/roles')
    await axe(page, 'roles')
  })

  await test.step('navigation: collapsible groups, remembered icon rail', async () => {
    await page.goto('/dashboard')
    const nav = page.getByRole('navigation', { name: 'Main menu' })
    const inventory = nav.getByRole('button', { name: 'Inventory' })
    await expect(inventory).toHaveAttribute('aria-expanded', 'false')
    await inventory.click()
    await expect(inventory).toHaveAttribute('aria-expanded', 'true')
    await nav.getByRole('link', { name: 'Products' }).click()
    await expect(page).toHaveURL(/\/products$/)
    await expect(nav.getByRole('link', { name: 'Products' })).toHaveAttribute('aria-current', 'page')
    // icon rail: survives a reload (cookie), then back to the full column
    await page.getByRole('button', { name: 'Collapse navigation' }).click()
    await page.reload()
    await expect(page.locator('.ss-shell')).toHaveAttribute('data-nav', 'collapsed')
    await page.getByRole('button', { name: 'Expand navigation' }).click()
    await expect(page.locator('.ss-shell')).toHaveAttribute('data-nav', 'expanded')
  })

  await test.step('sales report and profit & loss render', async () => {
    await page.goto('/reports/sales')
    await expect(page.getByRole('heading', { name: 'Sales report' }).first()).toBeVisible()
    await expect(page.getByRole('table').first()).toBeVisible()
    await page.goto('/reports/profit-loss')
    await expect(page.getByRole('heading', { name: 'Profit & loss' }).first()).toBeVisible()
    await expect(page.getByText(/Cost of goods sold/i).first()).toBeVisible()
  })

  await test.step('second branch + transfer', async () => {
    await page.goto('/settings/branches')
    await page.getByRole('button', { name: 'New branch' }).click()
    const dlg = page.getByRole('dialog')
    await dlg.getByLabel('Name').fill('Dhaka')
    await dlg.getByLabel('Code').fill('DHK')
    await dlg.getByRole('button', { name: 'Save' }).click()
    await expect(dlg).toBeHidden()
    await expect(page.getByRole('cell', { name: 'Dhaka' }).first()).toBeVisible()

    await page.goto('/stock/transfers/new')
    await page.getByLabel('To branch').selectOption({ label: 'Dhaka (DHK)' })
    await page.getByLabel('Serial units (one per line)').fill(SERIALS[1])
    await page.getByRole('button', { name: 'Transfer to Dhaka' }).click()
    await expect(page).toHaveURL(/\/stock\/transfers\/[0-9a-f-]{36}/)
    await expect(page.getByText(SERIALS[1], { exact: true }).first()).toBeVisible()
  })

  await test.step('375px wide: no horizontal page scroll on core screens (tables scroll inside their containers)', async () => {
    await page.setViewportSize({ width: 375, height: 760 })
    const overflow: string[] = []
    for (const path of ['/dashboard', '/sales/new', '/products', '/sales', '/stock', '/serials', saleUrl, '/purchases/new', '/reports/sales', '/customers']) {
      await page.goto(path)
      await expect(page.locator('#main-content')).toBeVisible()
      const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }))
      if (sw > cw + 1) {
        // name the outermost elements that stick out (to fix them, not just to know)
        const culprits = await page.evaluate((cw) => {
          const out: string[] = []
          for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
            const r = el.getBoundingClientRect()
            if (r.right > cw + 1 && r.width > 0 && !(el.parentElement && el.parentElement.getBoundingClientRect().right > cw + 1)) out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 3).join('.')} (${Math.round(r.right)})`)
          }
          return out.slice(0, 4)
        }, cw)
        overflow.push(`${path}: page is ${sw}px wide in a ${cw}px viewport: ${culprits.join(', ')}`)
      }
    }
    expect.soft(overflow).toEqual([])
    // the navigation is an off-canvas drawer at this width
    await page.goto('/dashboard')
    await page.getByRole('button', { name: 'Open navigation' }).click()
    const drawer = page.getByRole('dialog', { name: 'Navigation' })
    await expect(drawer).toBeVisible()
    await drawer.getByRole('button', { name: 'Sales' }).click()
    await drawer.getByRole('link', { name: 'Invoices' }).click()
    await expect(page).toHaveURL(/\/sales$/)
    await expect(drawer).toBeHidden()
    await page.setViewportSize({ width: 1280, height: 800 })
  })

  await test.step('sign out', async () => {
    await page.goto('/dashboard')
    await page.getByRole('button', { name: /^Account menu/ }).click()
    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(page).toHaveURL(/\/auth\/login/)
    await page.goto('/dashboard')
    await expect(page).toHaveURL(/\/auth\/login/)
  })

  expect(problems, 'CSP violations, Iconify API requests or uncaught page errors').toEqual([])
})
