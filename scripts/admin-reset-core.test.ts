import { describe, expect, it } from 'vitest'
import { normalizeEmail, parseArgs, validateEmail, validateNewPassword } from './admin-reset-core'

describe('admin-reset parseArgs', () => {
  it('reads --email in both forms', () => {
    expect(parseArgs(['--email', 'a@b.co']).email).toBe('a@b.co')
    expect(parseArgs(['--email=a@b.co']).email).toBe('a@b.co')
  })
  it('flags help and unknown args, and a dangling --email', () => {
    expect(parseArgs(['-h']).help).toBe(true)
    expect(parseArgs(['--password', 'x']).unknown).toEqual(['--password', 'x'])
    expect(parseArgs(['--email']).email).toBe('')
    expect(parseArgs([]).email).toBeNull()
  })
})

describe('admin-reset validation', () => {
  it('normalizes email like the login action', () => {
    expect(normalizeEmail('  Admin@Example.COM ')).toBe('admin@example.com')
  })
  it('validates email', () => {
    expect(validateEmail('')).toMatch(/required/)
    expect(validateEmail('nope')).toMatch(/valid/)
    expect(validateEmail('a b@c.d')).toMatch(/valid/)
    expect(validateEmail('admin@example.com')).toBeNull()
  })
  it('enforces the installer password minimum', () => {
    expect(validateNewPassword('short')).toMatch(/at least 10/)
    expect(validateNewPassword('x'.repeat(10))).toBeNull()
    expect(validateNewPassword('x'.repeat(201))).toMatch(/at most/)
  })
})
