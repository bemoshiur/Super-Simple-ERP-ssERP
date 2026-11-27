import { describe, expect, it } from 'vitest'
import { rowsOf, selectDriver } from './driver'

describe('selectDriver', () => {
  it('uses neon for *.neon.tech hosts and neon pooler hosts', () => {
    expect(selectDriver('postgresql://u:p@ep-cool-123.us-east-2.aws.neon.tech/db?sslmode=require', {})).toBe('neon')
    expect(selectDriver('postgresql://u:p@ep-cool-123-pooler.us-east-2.aws.neon.tech/db', {})).toBe('neon')
    expect(selectDriver('postgresql://u:p@EP-X.NEON.TECH/db', {})).toBe('neon')
    // only real Neon hosts: a hostname that merely contains "neon" is plain Postgres
    expect(selectDriver('postgresql://u:p@neon-db.internal/db', {})).toBe('pg')
    expect(selectDriver('postgresql://u:p@neon.tech.evil.example/db', {})).toBe('pg')
  })
  it('uses pg for everything else', () => {
    expect(selectDriver('postgresql://u:p@localhost:5432/db', {})).toBe('pg')
    expect(selectDriver('postgres://u:p@db.internal/db', {})).toBe('pg')
    expect(selectDriver('postgresql://postgres@%2Ftmp%2Fsock/db', {})).toBe('pg')
    expect(selectDriver('postgresql://u:p@mydb.abc.rds.amazonaws.com/db', {})).toBe('pg')
  })
  it('falls back to pg on missing or malformed urls', () => {
    expect(selectDriver(undefined, {})).toBe('pg')
    expect(selectDriver('not a url', {})).toBe('pg')
  })
  it('DB_DRIVER overrides host detection (case/space tolerant)', () => {
    expect(selectDriver('postgresql://u:p@localhost/db', { DB_DRIVER: 'neon' })).toBe('neon')
    expect(selectDriver('postgresql://u:p@x.neon.tech/db', { DB_DRIVER: 'pg' })).toBe('pg')
    expect(selectDriver('postgresql://u:p@x.neon.tech/db', { DB_DRIVER: ' PG ' })).toBe('pg')
  })
  it('ignores an empty DB_DRIVER and rejects unknown values', () => {
    expect(selectDriver('postgresql://u:p@x.neon.tech/db', { DB_DRIVER: '' })).toBe('neon')
    expect(() => selectDriver('postgresql://u:p@localhost/db', { DB_DRIVER: 'mysql' })).toThrow(/DB_DRIVER/)
  })
})

describe('rowsOf', () => {
  it('reads .rows from node-postgres / neon style results', () => {
    expect(rowsOf<{ a: number }>({ rows: [{ a: 1 }], rowCount: 1 })).toEqual([{ a: 1 }])
  })
  it('accepts a bare array (postgres-js style)', () => {
    expect(rowsOf([{ a: 1 }, { a: 2 }])).toEqual([{ a: 1 }, { a: 2 }])
  })
  it('returns [] for anything without rows', () => {
    expect(rowsOf(undefined)).toEqual([])
    expect(rowsOf(null)).toEqual([])
    expect(rowsOf({})).toEqual([])
    expect(rowsOf({ rows: 'x' })).toEqual([])
  })
})
