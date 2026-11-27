import { expect, type Page } from '@playwright/test'

/** Both specs install and write data: only run them inside scripts/e2e.sh (throwaway database + app). */
export function requireHarness() {
  if (process.env.E2E_HARNESS !== '1' || !process.env.E2E_DATABASE_URL || !process.env.E2E_BASE_URL) {
    throw new Error('Run the end-to-end tests with `npm run test:e2e` (or `npm run screenshots`): they need the throwaway database and app that scripts/e2e.sh starts.')
  }
  return { databaseUrl: process.env.E2E_DATABASE_URL, baseUrl: process.env.E2E_BASE_URL }
}

export const TOKEN = process.env.E2E_INSTALL_TOKEN ?? 'e2e-install-token-0123456789'
export const ADMIN = { name: 'Rahim Admin', email: 'admin@e2e.test', password: 'e2e-admin-password-1' }

/** Run the /install wizard with the install token (fresh database). */
export async function installViaWizard(page: Page, company = 'E2E Electronics') {
  await page.goto('/')
  await expect(page).toHaveURL(/\/install/)
  await page.getByLabel('Install token').fill(TOKEN)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText('Database connection')).toBeVisible()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Run migrations' }).click()
  await expect(page.getByText(/Migrations applied/)).toBeVisible({ timeout: 60_000 })
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByLabel('Company name').fill(company)
  await page.getByLabel('Your name').fill(ADMIN.name)
  await page.getByLabel('Admin email').fill(ADMIN.email)
  await page.getByLabel('Password (at least 10 characters)').fill(ADMIN.password)
  await page.getByLabel('Confirm password').fill(ADMIN.password)
  await page.getByRole('button', { name: 'Install ssERP' }).click()
  await expect(page.getByText(/ssERP is installed/)).toBeVisible({ timeout: 60_000 })
}

export async function login(page: Page) {
  await page.goto('/auth/login')
  await page.getByLabel('Email').fill(ADMIN.email)
  await page.getByLabel('Password').fill(ADMIN.password)
  await page.getByRole('button', { name: /sign in/i }).click()
  await expect(page).toHaveURL(/\/dashboard/)
}
