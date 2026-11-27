import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { compareMigrations, createMigrationsStatus, readJournal, type AppliedInfo, type JournalInfo } from './migrations-status'

const journal: JournalInfo = { count: 3, lastWhen: 3000, lastTag: '0002_x' }

describe('compareMigrations', () => {
  it('ok when the database has every journal entry', () => {
    expect(compareMigrations(journal, { count: 3, lastCreatedAt: 3000 })).toBe('ok')
  })
  it('pending when the database is behind by count or timestamp, or has nothing', () => {
    expect(compareMigrations(journal, { count: 2, lastCreatedAt: 2000 })).toBe('pending')
    expect(compareMigrations(journal, { count: 3, lastCreatedAt: 2999 })).toBe('pending')
    expect(compareMigrations(journal, { count: 0, lastCreatedAt: null })).toBe('pending')
  })
})

describe('createMigrationsStatus', () => {
  it('caches for the TTL and re-reads after it', async () => {
    let t = 0
    const applied = vi.fn(async (): Promise<AppliedInfo> => ({ count: 2, lastCreatedAt: 2000 }))
    const status = createMigrationsStatus({ journal: async () => journal, applied }, { ttlMs: 60_000, now: () => t })
    expect(await status()).toBe('pending')
    t = 59_999
    applied.mockResolvedValue({ count: 3, lastCreatedAt: 3000 })
    expect(await status()).toBe('pending')
    expect(applied).toHaveBeenCalledTimes(1)
    t = 60_000
    expect(await status()).toBe('ok')
    expect(applied).toHaveBeenCalledTimes(2)
  })

  it('never throws: a failing reader answers unknown', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const status = createMigrationsStatus({ journal: async () => journal, applied: () => Promise.reject(new Error('db down')) })
    expect(await status()).toBe('unknown')
    const sync = createMigrationsStatus({
      journal: () => {
        throw new Error('no file')
      },
      applied: async () => ({ count: 0, lastCreatedAt: null }),
    })
    expect(await sync()).toBe('unknown')
  })

  it('shares one in-flight check', async () => {
    let release!: (v: AppliedInfo) => void
    const applied = vi.fn(() => new Promise<AppliedInfo>((r) => (release = r)))
    const status = createMigrationsStatus({ journal: async () => journal, applied }, { now: () => 0 })
    const all = Promise.all([status(), status()])
    await new Promise((r) => setTimeout(r, 0))
    release({ count: 3, lastCreatedAt: 3000 })
    expect(await all).toEqual(['ok', 'ok'])
    expect(applied).toHaveBeenCalledTimes(1)
  })
})

describe('readJournal', () => {
  it('reads count and the newest entry', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sserp-journal-'))
    mkdirSync(path.join(dir, 'meta'))
    writeFileSync(path.join(dir, 'meta', '_journal.json'), JSON.stringify({ entries: [{ when: 1, tag: 'a' }, { when: 5, tag: 'b' }] }))
    expect(await readJournal(dir)).toEqual({ count: 2, lastWhen: 5, lastTag: 'b' })
  })

  it('the shipped journal is readable', async () => {
    const j = await readJournal(path.join(import.meta.dirname, '..', '..', 'drizzle'))
    expect(j.count).toBeGreaterThan(10)
  })
})
