import { and, desc, eq, inArray } from 'drizzle-orm'
import { schema, type Db } from './db'
import { safeLogoUrl } from './settings/pure'

export type CompanyProfile = { name: string; address: string | null; phone: string | null; email: string | null; footer: string | null; logoUrl: string | null; currencySymbol: string | undefined }

/** settings keys read for printed documents (edited in the Settings UI, Task 10). */
export const PROFILE_KEYS = ['currency_symbol', 'company_address', 'company_phone', 'company_email', 'invoice_footer', 'logo_url'] as const

/**
 * Company header for printed invoices: name from companies; address / phone / footer from settings, falling back to
 * the default branch's address / phone. Read-only.
 */
export async function getCompanyProfile(db: Pick<Db, 'select'>, companyId: string): Promise<CompanyProfile> {
  const [company] = await db.select({ name: schema.companies.name }).from(schema.companies).where(eq(schema.companies.id, companyId))
  const rows = await db
    .select({ key: schema.settings.key, value: schema.settings.value })
    .from(schema.settings)
    .where(and(eq(schema.settings.companyId, companyId), inArray(schema.settings.key, [...PROFILE_KEYS])))
  const [branch] = await db
    .select({ address: schema.branches.address, phone: schema.branches.phone })
    .from(schema.branches)
    .where(eq(schema.branches.companyId, companyId))
    .orderBy(desc(schema.branches.isDefault))
    .limit(1)
  const get = (k: (typeof PROFILE_KEYS)[number]) => rows.find((r) => r.key === k)?.value?.trim() || null
  return {
    name: company?.name ?? '',
    address: get('company_address') ?? branch?.address ?? null,
    phone: get('company_phone') ?? branch?.phone ?? null,
    email: get('company_email'),
    footer: get('invoice_footer'),
    // Re-validated on read (defence in depth): only https:// or same-origin paths ever reach <img src>.
    logoUrl: safeLogoUrl(get('logo_url')),
    currencySymbol: get('currency_symbol') ?? undefined,
  }
}
