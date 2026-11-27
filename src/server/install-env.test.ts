import { describe, expect, it } from 'vitest'
import {
  checkEnv,
  classifyInstalled,
  installGate,
  isProdLike,
  seedPreflight,
  tokensMatch,
  generateAuthSecret,
  installGuard,
  mergeEnv,
  parseEnv,
  redactDatabaseUrl,
  validateAuthSecret,
  validateDatabaseUrl,
} from './install-env'

describe('validateDatabaseUrl', () => {
  it('accepts postgres and postgresql urls', () => {
    expect(validateDatabaseUrl('postgresql://u:p@ep-x.neon.tech/neondb?sslmode=require').ok).toBe(true)
    expect(validateDatabaseUrl('postgres://u:p@h/db').ok).toBe(true)
  })
  it('rejects empty, wrong scheme, garbage, missing db', () => {
    for (const bad of [undefined, '', '  ', 'mysql://u:p@h/db', 'http://x/db', 'not a url', 'postgresql://u:p@h', 'postgresql://u:p@h/']) {
      expect(validateDatabaseUrl(bad).ok, String(bad)).toBe(false)
    }
  })
})

describe('validateAuthSecret / generateAuthSecret', () => {
  it('requires 32+ chars', () => {
    expect(validateAuthSecret(undefined).ok).toBe(false)
    expect(validateAuthSecret('x'.repeat(31)).ok).toBe(false)
    expect(validateAuthSecret('x'.repeat(32)).ok).toBe(true)
  })
  it('generates valid, unique, url-safe secrets', () => {
    const a = generateAuthSecret()
    const b = generateAuthSecret()
    expect(a).not.toBe(b)
    expect(a.length).toBeGreaterThanOrEqual(64)
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(validateAuthSecret(a).ok).toBe(true)
  })
})

describe('checkEnv', () => {
  it('reports each variable and overall readiness', () => {
    expect(checkEnv({}).ready).toBe(false)
    const s = checkEnv({ DATABASE_URL: 'postgresql://u:p@h/db', AUTH_SECRET: 'x'.repeat(40) })
    expect(s.ready).toBe(true)
    const half = checkEnv({ DATABASE_URL: 'postgresql://u:p@h/db' })
    expect(half.databaseUrl.ok).toBe(true)
    expect(half.authSecret.ok).toBe(false)
    expect(half.ready).toBe(false)
  })
})

describe('redactDatabaseUrl', () => {
  it('hides the password', () => {
    const r = redactDatabaseUrl('postgresql://user:s3cret@host/db?sslmode=require')
    expect(r).not.toContain('s3cret')
    expect(r).toContain('user')
    expect(r).toContain('host')
  })
  it('does not echo unparseable input', () => {
    expect(redactDatabaseUrl('s3cret garbage')).toBe('(invalid URL)')
  })
})

describe('parseEnv / mergeEnv', () => {
  it('parses quotes, export, comments', () => {
    const e = parseEnv('# c\nA=1\nexport B="two words"\nC=\'x\'\nD=val # trailing\n\nbad line\n')
    expect(e).toEqual({ A: '1', B: 'two words', C: 'x', D: 'val' })
  })
  it('preserves unrelated lines and replaces in place', () => {
    const before = '# my env\nFOO=bar\nDATABASE_URL=old\n\nOTHER=1\n'
    const after = mergeEnv(before, { DATABASE_URL: 'postgresql://u:p@h/db', AUTH_SECRET: 'abc' })
    expect(after).toBe('# my env\nFOO=bar\nDATABASE_URL=postgresql://u:p@h/db\n\nOTHER=1\nAUTH_SECRET=abc\n')
  })
  it('creates content from empty and round-trips', () => {
    const out = mergeEnv('', { A: 'x y', B: 'q"r' })
    expect(parseEnv(out)).toEqual({ A: 'x y', B: 'q"r' })
    expect(out.endsWith('\n')).toBe(true)
  })
  it('is idempotent', () => {
    const once = mergeEnv('FOO=1\n', { AUTH_SECRET: 'abc' })
    expect(mergeEnv(once, { AUTH_SECRET: 'abc' })).toBe(once)
  })
  it('handles CRLF input', () => {
    expect(parseEnv(mergeEnv('A=1\r\nB=2\r\n', { B: '3' }))).toEqual({ A: '1', B: '3' })
  })
})

describe('installGuard', () => {
  it('app pages require install', () => {
    expect(installGuard('no', 'app')).toBe('redirect-install')
    expect(installGuard('yes', 'app')).toBe('allow')
  })
  it('install pages are forbidden once installed', () => {
    expect(installGuard('no', 'install')).toBe('allow')
    expect(installGuard('yes', 'install')).toBe('forbidden')
  })
  it('unknown never redirects or allows', () => {
    expect(installGuard('unknown', 'app')).toBe('unavailable')
    expect(installGuard('unknown', 'install')).toBe('unavailable')
  })
})

describe('classifyInstalled', () => {
  it('rows decide yes/no', () => {
    expect(classifyInstalled({ rows: 1 })).toBe('yes')
    expect(classifyInstalled({ rows: 0 })).toBe('no')
  })
  it('missing table (42P01, even wrapped) is no', () => {
    expect(classifyInstalled({ error: { code: '42P01' } })).toBe('no')
    expect(classifyInstalled({ error: new Error('Failed query', { cause: { code: '42P01' } }) })).toBe('no')
    expect(classifyInstalled({ error: new Error('relation "settings" does not exist') })).toBe('no')
  })
  it('any other error is unknown', () => {
    expect(classifyInstalled({ error: new Error('connection refused') })).toBe('unknown')
    expect(classifyInstalled({ error: { code: '57P01' } })).toBe('unknown')
    expect(classifyInstalled({ error: 'boom' })).toBe('unknown')
  })
})

describe('installGate', () => {
  const T = 'a-secret-install-token'
  it('token set: only a matching token passes (prod or dev)', () => {
    for (const prodLike of [true, false]) {
      expect(installGate({ configured: T, prodLike, presented: T })).toBe('allow')
      expect(installGate({ configured: T, prodLike, presented: T + 'x' })).toBe('token-required')
      expect(installGate({ configured: T, prodLike, presented: 'short' })).toBe('token-required')
      expect(installGate({ configured: T, prodLike, presented: '' })).toBe('token-required')
      expect(installGate({ configured: T, prodLike, presented: null })).toBe('token-required')
    }
  })
  it('token unset: dev allowed, production/Vercel disabled', () => {
    expect(installGate({ configured: undefined, prodLike: false })).toBe('allow')
    expect(installGate({ configured: '', prodLike: false, presented: 'x' })).toBe('allow')
    expect(installGate({ configured: undefined, prodLike: true })).toBe('disabled')
    expect(installGate({ configured: undefined, prodLike: true, presented: T })).toBe('disabled')
  })
  it('too-short configured token is refused', () => {
    expect(installGate({ configured: 'short', prodLike: false, presented: 'short' })).toBe('misconfigured')
  })
  it('isProdLike and tokensMatch', () => {
    expect(isProdLike({})).toBe(false)
    expect(isProdLike({ NODE_ENV: 'production' })).toBe(true)
    expect(isProdLike({ VERCEL: '1' })).toBe(true)
    expect(tokensMatch('abc', 'abc')).toBe(true)
    expect(tokensMatch('abc', 'abcd')).toBe(false)
  })
})

describe('seedPreflight', () => {
  it('blocks on installed flag or any existing user', () => {
    expect(seedPreflight({ installedFlag: true, userCount: 0 })).toBe('installed')
    expect(seedPreflight({ installedFlag: false, userCount: 1 })).toBe('not-empty')
    expect(seedPreflight({ installedFlag: false, userCount: 0 })).toBe('ok')
  })
})

describe('.env quoting round-trips through Next.js (dotenv + dotenv-expand) and parseEnv', () => {
  it('values with $, quotes, spaces, # and backslashes survive', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { loadEnvConfig } = await import('@next/env')
    const values = {
      T15_DOLLAR: 'postgres://u:pa$$word@h/db',
      T15_DQUOTE: 'a"b$HOME',
      T15_SPACE: 'a b # c',
      T15_BACKSLASH: 'a\\nb\\c',
      T15_SQUOTE: "it's $x",
    }
    const dir = mkdtempSync(join(tmpdir(), 'sserp-env-'))
    try {
      writeFileSync(join(dir, '.env'), mergeEnv('', values)) // .env: under vitest NODE_ENV=test skips .env.local
      for (const k of Object.keys(values)) delete process.env[k]
      loadEnvConfig(dir, true, { info: () => {}, error: () => {} }, true)
      for (const [k, v] of Object.entries(values)) expect(process.env[k], k).toBe(v)
      expect(parseEnv(mergeEnv('', values))).toEqual(values)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      for (const k of Object.keys(values)) delete process.env[k]
    }
  })
})
