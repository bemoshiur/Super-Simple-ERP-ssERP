import { describe, expect, it } from 'vitest'
import { DEMO_CUSTOMERS, DEMO_PRODUCTS, DEMO_SKUS, DEMO_VENDORS, describeTarget, evaluateTarget, parseDemoArgs } from './seed'

describe('parseDemoArgs', () => {
  it('reads --force, --with-users and --help; collects anything else as unknown', () => {
    expect(parseDemoArgs([])).toEqual({ force: false, withUsers: false, yes: false, help: false, unknown: [] })
    expect(parseDemoArgs(['--force', '--with-users'])).toMatchObject({ force: true, withUsers: true })
    expect(parseDemoArgs(['--yes']).yes).toBe(true)
    expect(parseDemoArgs(['-h']).help).toBe(true)
    expect(parseDemoArgs(['--frce', 'x']).unknown).toEqual(['--frce', 'x'])
  })
})

describe('demo catalogue', () => {
  it('matches the brief: ~12 products (serial + plain), 3 vendors incl. ABC Electronics, 6 customers incl. Rahim', () => {
    expect(DEMO_PRODUCTS).toHaveLength(12)
    expect(DEMO_PRODUCTS.some((p) => p.serial)).toBe(true)
    expect(DEMO_PRODUCTS.some((p) => !p.serial)).toBe(true)
    expect(new Set(DEMO_SKUS).size).toBe(12)
    expect(DEMO_VENDORS).toContain('ABC Electronics')
    expect(DEMO_VENDORS).toHaveLength(3)
    expect(DEMO_CUSTOMERS).toContain('Rahim')
    expect(DEMO_CUSTOMERS).toHaveLength(6)
    // every price is a plain amount the data layer accepts, and selling above cost
    for (const p of DEMO_PRODUCTS) expect(Number(p.sell)).toBeGreaterThan(Number(p.buy))
  })
  it('uses the SKUs of the example import file', () => {
    for (const sku of ['CAM-HIK-2MP', 'PHN-REDMI-13C', 'RTR-TPL-C6']) expect(DEMO_SKUS).toContain(sku)
  })
})

describe('target guard', () => {
  it('describes host and database without credentials', () => {
    const t = describeTarget('postgresql://admin:s3cret@ep-cool-123.us-east-2.aws.neon.tech/neondb?sslmode=require')
    expect(t).toEqual({ host: 'ep-cool-123.us-east-2.aws.neon.tech', database: 'neondb', local: false })
    expect(JSON.stringify(t)).not.toMatch(/s3cret|admin/)
    for (const url of ['postgres://u:p@localhost:5432/sserp', 'postgres://127.0.0.1/db', 'postgres://u@[::1]:5432/db', 'postgresql://postgres@%2Ftmp%2Fsock:5432/postgres']) expect(describeTarget(url).local, url).toBe(true)
    expect(describeTarget('postgres://u@db.internal.example.com/x').local).toBe(false)
    expect(describeTarget('postgres://u@localhost.evil.com/x').local).toBe(false)
    expect(describeTarget(undefined)).toMatchObject({ local: false })
    expect(describeTarget('not a url').local).toBe(false)
  })
  it('prefers ?host= over the URL host; an empty host is local only when PGHOST is unset', () => {
    expect(describeTarget('postgres://localhost/db?host=ep-x.neon.tech', {})).toMatchObject({ host: 'ep-x.neon.tech', local: false })
    expect(describeTarget('postgres://db.example.com/db?host=%2Ftmp', {})).toMatchObject({ host: '/tmp', local: true })
    expect(describeTarget('postgres:///db', {})).toMatchObject({ local: true })
    expect(describeTarget('postgres:///db', { PGHOST: 'prod.example.com' })).toMatchObject({ host: 'prod.example.com', local: false })
    expect(describeTarget('postgres:///db?host=localhost,prod.example.com', {}).local).toBe(false)
  })
  const local = describeTarget('postgres://u@localhost/dev')
  const remote = describeTarget('postgres://u@ep-x.neon.tech/prod')
  it('local development databases proceed without --yes', () => {
    expect(evaluateTarget(local, { yes: false, interactive: false })).toEqual({ action: 'proceed' })
  })
  it('remote or production targets need --yes: asked in a terminal, refused when non-interactive', () => {
    expect(evaluateTarget(remote, { yes: true, interactive: false })).toEqual({ action: 'proceed' })
    expect(evaluateTarget(remote, { yes: false, interactive: true })).toEqual({ action: 'confirm' })
    const r = evaluateTarget(remote, { yes: false, interactive: false })
    expect(r).toMatchObject({ action: 'refuse', message: expect.stringContaining('ep-x.neon.tech/prod') })
    expect(evaluateTarget(local, { nodeEnv: 'production', yes: false, interactive: false })).toMatchObject({ action: 'refuse', message: expect.stringContaining('NODE_ENV=production') })
    expect(evaluateTarget(local, { nodeEnv: 'production', yes: true, interactive: false })).toEqual({ action: 'proceed' })
  })
})
