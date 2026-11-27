/**
 * Company settings (Settings page). Keys written here are exactly the ones read elsewhere:
 *  - getCompanyProfile (src/server/company.ts, printed invoices): currency_symbol, company_address, company_phone,
 *    company_email, invoice_footer, logo_url
 *  - nextDocNumber (src/server/docnumbers.ts): DOC_PREFIX[kind].key
 * Company name lives in companies.name. Edits are logged (activity_log before/after) and diffed into record_history
 * (entity 'settings', entity_id = company id) in the same transaction.
 */
import { and, eq, inArray } from 'drizzle-orm'
import { logActivity } from '../audit'
import { schema, type Db } from '../db'
import { DOC_PREFIX } from '../docnumbers'
import { NotFoundError } from '../errors'
import { diffFields, writeHistory } from '../history'
import { settingsSchema, type SettingsData } from './pure'

/** Settings form field -> settings key. */
export const SETTING_KEY = {
  companyAddress: 'company_address',
  companyPhone: 'company_phone',
  companyEmail: 'company_email',
  currencySymbol: 'currency_symbol',
  invoiceFooter: 'invoice_footer',
  logoUrl: 'logo_url',
  prefixSale: DOC_PREFIX.sale.key,
  prefixPurchase: DOC_PREFIX.purchase.key,
  prefixSaleReturn: DOC_PREFIX.sale_return.key,
  prefixPurchaseReturn: DOC_PREFIX.purchase_return.key,
  prefixService: DOC_PREFIX.service.key,
} as const satisfies Record<Exclude<keyof SettingsData, 'companyName'>, string>

type FieldKey = keyof typeof SETTING_KEY
const FIELDS = Object.keys(SETTING_KEY) as FieldKey[]
const TRACKED = ['companyName', ...FIELDS] as const

const DEFAULTS: Partial<Record<FieldKey, string>> = {
  currencySymbol: '৳',
  prefixSale: DOC_PREFIX.sale.fallback,
  prefixPurchase: DOC_PREFIX.purchase.fallback,
  prefixSaleReturn: DOC_PREFIX.sale_return.fallback,
  prefixPurchaseReturn: DOC_PREFIX.purchase_return.fallback,
  prefixService: DOC_PREFIX.service.fallback,
}

export type CompanySettings = { companyName: string } & Record<FieldKey, string | null>

export async function getSettings(db: Pick<Db, 'select'>, companyId: string): Promise<CompanySettings> {
  const [company] = await db.select({ name: schema.companies.name }).from(schema.companies).where(eq(schema.companies.id, companyId))
  if (!company) throw new NotFoundError('Company')
  const rows = await db
    .select({ key: schema.settings.key, value: schema.settings.value })
    .from(schema.settings)
    .where(and(eq(schema.settings.companyId, companyId), inArray(schema.settings.key, Object.values(SETTING_KEY))))
  const out = { companyName: company.name } as CompanySettings
  for (const f of FIELDS) out[f] = rows.find((r) => r.key === SETTING_KEY[f])?.value ?? DEFAULTS[f] ?? null
  return out
}

export async function updateSettings(db: Db, companyId: string, userId: string, input: unknown): Promise<CompanySettings> {
  const d = settingsSchema.parse(input)
  return db.transaction(async (tx) => {
    // Lock the company row: concurrent settings saves are serialised and the before/after diff is exact.
    const [locked] = await tx.select({ id: schema.companies.id }).from(schema.companies).where(eq(schema.companies.id, companyId)).for('update')
    if (!locked) throw new NotFoundError('Company')
    const before = await getSettings(tx, companyId)
    const after: CompanySettings = { companyName: d.companyName, ...Object.fromEntries(FIELDS.map((f) => [f, d[f]])) } as CompanySettings
    const diff = diffFields(before, after, TRACKED)
    if (Object.keys(diff).length === 0) return before

    if (d.companyName !== before.companyName) await tx.update(schema.companies).set({ name: d.companyName, updatedAt: new Date() }).where(eq(schema.companies.id, companyId))
    for (const f of FIELDS) {
      if (!(f in diff)) continue
      const value = after[f]
      if (value === null) {
        await tx.delete(schema.settings).where(and(eq(schema.settings.companyId, companyId), eq(schema.settings.key, SETTING_KEY[f])))
      } else {
        await tx
          .insert(schema.settings)
          .values({ companyId, key: SETTING_KEY[f], value })
          .onConflictDoUpdate({ target: [schema.settings.companyId, schema.settings.key], set: { value, updatedAt: new Date() } })
      }
    }
    await writeHistory(tx, { companyId, userId, entity: 'settings', entityId: companyId, diff })
    const pick = (s: CompanySettings) => Object.fromEntries(Object.keys(diff).map((k) => [k, s[k as keyof CompanySettings]]))
    await logActivity({ companyId, userId, action: 'settings.update', entity: 'settings', entityId: companyId, before: pick(before), after: pick(after) }, tx)
    return after
  })
}
